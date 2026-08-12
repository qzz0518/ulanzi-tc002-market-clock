// The one piece of ZOS wiring three tabs need: "send the clock to this thing,
// and let me take it back".
//
// 内容, 音乐 and 游戏 all want the same button — pin a focus, show whether the
// device is already there, release it on a second press. That used to live
// inline in WorkspaceActions; a second and third copy is how the three drift
// apart, so the plumbing sits here and the toggle rule itself stays pure in
// zos-link.ts where it can be unit-tested without React.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createZosLink,
  zosPinnedOn,
  zosToggleFocus,
  type ZosDisplay,
  type ZosLink,
} from "@/lib/zos-link";
import { errorMessage } from "@/lib/utils";

export interface ZosFocusController {
  /** The display the service last accepted, or null before the first read. */
  display: ZosDisplay | null;
  /** A PUT is in flight. */
  busy: boolean;
  /** Last failure, or null. Callers render this — a silent failure is the worst
   *  outcome for a button whose only feedback is 30 cm of LED across the room. */
  error: string | null;
  /** Whether the device is pinned on exactly this focus. */
  pinnedOn(focus: string): boolean;
  /** Pin `focus`; pressing the one it is already pinned to releases the knob. */
  toggle(focus: string): void;
}

/**
 * @param active only ZOS answers `/api/os/display`; under any other firmware
 *   this must stay inert rather than polling an endpoint that cannot help.
 */
export function useZosFocus(active: boolean): ZosFocusController {
  const linkRef = useRef<ZosLink | null>(null);
  const [display, setDisplay] = useState<ZosDisplay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One read, not a loop. This drives a button label; the live pin state belongs
  // to the 系统 panel, which polls. Every action here answers with the display
  // the service accepted, so the label stays correct without a second cadence.
  useEffect(() => {
    if (!active) {
      setDisplay(null);
      return;
    }
    let cancelled = false;
    const link = createZosLink({
      onState: (state) => {
        if (!cancelled) setDisplay(state.display);
      },
    });
    linkRef.current = link;
    void link.refreshState();
    return () => {
      cancelled = true;
      linkRef.current = null;
    };
  }, [active]);

  const send = useCallback(async (focus: string | null) => {
    const link = linkRef.current ?? createZosLink();
    setBusy(true);
    setError(null);
    try {
      // The service echoes the sanitized command, so the label follows what the
      // firmware will actually receive rather than what the click asked for.
      setDisplay(await link.setDisplay(focus, focus !== null));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    display,
    busy,
    error,
    pinnedOn: (focus: string) => active && zosPinnedOn(display, focus),
    toggle: (focus: string) => void send(zosToggleFocus(display, focus)),
  };
}
