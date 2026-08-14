import { useState } from "react";
import { Button, Chip, Input } from "@cladd-ui/react";
import { Check, Trash2 } from "lucide-react";
import { jsonApi } from "@/lib/api";
import { useAppToast } from "@/lib/use-app-toast";
import { errorMessage } from "@/lib/utils";
import {
  VIBE_KEY_PROVIDERS,
  VIBE_KEY_STATE_LABEL,
  VIBE_MAX_KEY_LENGTH,
  vibeKeyState,
  type VibeCatalogEntry,
  type VibeKeysResponse,
  type VibeKeyState,
} from "@/lib/vibe";

interface VibeKeysProps {
  catalog: VibeCatalogEntry[];
  /** The status envelope's `keys` map: where each key came from, never the key. */
  keys: Record<string, string>;
  /** Re-reads the status so a freshly pasted key gets one real fetch attempt. */
  onSaved: () => Promise<void>;
}

// A stored key is the only state the user can undo here; the other two are
// facts about the machine, so they read neutral rather than as a warning.
const STATE_COLOR: Record<VibeKeyState, "brand" | "neutral"> = {
  stored: "brand",
  environment: "neutral",
  unset: "neutral",
};

function VibeKeyRow({
  providerId,
  displayName,
  state,
  onSubmit,
}: {
  providerId: string;
  displayName: string;
  state: VibeKeyState;
  onSubmit: (providerId: string, key: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const inputId = `vibe-key-${providerId}`;

  const submit = async (key: string, action: "save" | "clear") => {
    setBusy(action);
    // The draft is dropped on success whichever way it went: the field must
    // never keep a key around after the server has taken it.
    if (await onSubmit(providerId, key)) setDraft("");
    setBusy(null);
  };

  return (
    <li className="vibe-key">
      <div className="vibe-key__head">
        <label className="vibe-key__name" htmlFor={inputId}>{displayName}</label>
        <Chip size="md" color={STATE_COLOR[state]} variant="transparent">
          {VIBE_KEY_STATE_LABEL[state]}
        </Chip>
      </div>
      <div className="vibe-key__form">
        <Input
          inputId={inputId}
          type="password"
          size="md"
          className="vibe-key__input"
          value={draft}
          maxLength={VIBE_MAX_KEY_LENGTH}
          placeholder={state === "unset" ? "粘贴 API 密钥" : "粘贴新密钥可替换"}
          // A credential must not reach the browser's saved-password store, and
          // spellcheck would ship it to the platform's remote checker.
          inputComponentProps={{ autoComplete: "off", spellCheck: false }}
          disabled={busy !== null}
          onChange={setDraft}
        />
        <Button
          type="button"
          size="md"
          color="brand"
          loading={busy === "save"}
          disabled={busy !== null || draft.trim() === ""}
          onClick={() => void submit(draft, "save")}
        >
          <Check aria-hidden="true" />保存
        </Button>
        {state === "stored" && (
          <Button
            type="button"
            size="md"
            color="red"
            variant="transparent"
            loading={busy === "clear"}
            disabled={busy !== null}
            // An empty string is the wire's own clear signal — no second route.
            onClick={() => void submit("", "clear")}
          >
            <Trash2 aria-hidden="true" />清除
          </Button>
        )}
      </div>
    </li>
  );
}

export function VibeKeys({ catalog, keys, onSaved }: VibeKeysProps) {
  const toast = useAppToast();
  const names = new Map(catalog.map((entry) => [entry.id, entry.displayName]));

  const submit = async (providerId: string, key: string): Promise<boolean> => {
    const trimmed = key.trim();
    try {
      // The response carries the new `keys` map but never the key itself; the
      // panel still re-reads status, because a working key should make the
      // vendor appear in the list without a second click.
      await jsonApi<VibeKeysResponse>("/api/vibe/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, key: trimmed }),
      });
      await onSaved();
      toast.success(trimmed === "" ? "密钥已清除" : "密钥已保存");
      return true;
    } catch (error) {
      toast.error(trimmed === "" ? "密钥未清除" : "密钥未保存", { description: errorMessage(error) });
      return false;
    }
  };

  return (
    <section className="vibe-keys" aria-labelledby="vibe-keys-title">
      <div className="vibe-section__head">
        <h2 id="vibe-keys-title">API 密钥</h2>
        <p>
          这两家没有本地 CLI 登录可借，需要自己粘贴密钥；服务以 0600 权限存在本机，
          页面只显示来源、从不回显密钥。
        </p>
      </div>
      <ul className="vibe-key-list">
        {VIBE_KEY_PROVIDERS.map((providerId) => (
          <VibeKeyRow
            key={providerId}
            providerId={providerId}
            displayName={names.get(providerId) ?? providerId}
            state={vibeKeyState(keys, providerId)}
            onSubmit={submit}
          />
        ))}
      </ul>
    </section>
  );
}
