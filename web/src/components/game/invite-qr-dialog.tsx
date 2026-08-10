import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Dialog } from "@cladd-ui/react";
import { jsonApi } from "@/lib/api";
import type { ControlAccessInfo } from "@/types";

// Shared QR invitation dialog: the Pong "invite gamepad" button and the doodle
// wall "invite guests" button both point a phone at a companion page under the
// service's LAN origin, resolved through /api/access on each open.

interface ControlAccessResponse {
  access: ControlAccessInfo;
}

interface InviteQrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Path under the service origin, without leading slash — e.g. "pad?room=ab12". */
  path: string;
  /** Live status line rendered under the QR code. */
  hint?: ReactNode;
}

const bodyStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  justifyItems: "center",
  maxWidth: "20rem",
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "0.66rem",
  lineHeight: 1.6,
  textAlign: "center",
};

const addressStyle: CSSProperties = {
  maxWidth: "100%",
  overflowWrap: "anywhere",
  color: "var(--muted-foreground)",
  fontFamily: "var(--mono)",
  fontSize: "0.62rem",
  textAlign: "center",
  userSelect: "all",
};

export function InviteQrDialog({
  open,
  onOpenChange,
  title,
  description,
  path,
  hint,
}: InviteQrDialogProps) {
  const [base, setBase] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      let origin = `${window.location.origin}/`;
      try {
        const { access } = await jsonApi<ControlAccessResponse>("/api/access", { cache: "no-store" });
        // Prefer the LAN address a phone can actually reach; the page origin
        // still works when the studio itself is opened over the LAN.
        origin = access.url ?? access.suggestedUrl ?? origin;
      } catch {
        // The page origin fallback keeps the QR usable without /api/access.
      }
      if (!cancelled) setBase(origin);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const url = base ? `${base}${path}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div style={bodyStyle}>
        <p style={descriptionStyle}>{description}</p>
        {url ? (
          <>
            <div className="device-access-qr" aria-label="邀请二维码">
              <QRCodeSVG value={url} size={176} level="M" marginSize={2} bgColor="#ffffff" fgColor="#111511" />
            </div>
            <code style={addressStyle}>{url}</code>
          </>
        ) : (
          <p style={descriptionStyle} role="status">正在获取局域网地址…</p>
        )}
        {hint}
      </div>
    </Dialog>
  );
}
