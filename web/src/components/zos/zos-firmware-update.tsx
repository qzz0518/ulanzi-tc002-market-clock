import { CircleAlert, HardDriveDownload, Info, PackageCheck, RefreshCw } from "lucide-react";
import { Button, Checkbox, SectionTitle, Surface } from "@cladd-ui/react";
import type { FirmwareMode } from "@/lib/firmware-mode";
import {
  describeImageAge,
  describeUpgradeGate,
  describeUpgradeWatch,
  formatImageBytes,
  type ZosFirmwareStatus,
  type ZosUpgradeRequest,
} from "@/lib/zos-link";
import "./zos-console.css";

// The console's side of a firmware install: say what image is packed, take one
// explicit consent, and then report only what can actually be observed.
//
// What can be observed is thin, by design. The vendor updater tears every
// service down, writes flash and reboots, so the device stops answering halfway
// through and there is no progress to read. This section therefore never says
// 更新成功 — it says the request went out, the device went quiet, the device came
// back. Which build ended up in flash is the clock's to show, and announcing it
// from here would hide the failure most worth seeing: a device that comes back
// on the old build.

export interface ZosFirmwareUpdateProps {
  /** Which firmware is on the clock now. Only ZOS has a ZOS to update. */
  mode: FirmwareMode;
  /** ZOS is in flash — decides whether an absent device gets "reconnect it" or
   * "not applicable". */
  zosFlashed: boolean;
  /** The service's liveness verdict. Never re-derive it against a browser clock. */
  live: boolean;
  /** `GET /api/os/firmware/status`; null while it has not answered. */
  status: ZosFirmwareStatus | null;
  statusError: string | null;
  /** The install this session asked for; null when it never did. */
  request: ZosUpgradeRequest | null;
  /**
   * `ZosState.upgradeSeq` — the request the service is still carrying. It is
   * evidence that the ask is on the wire, not a progress reading: a service
   * restart clears it, and the device would then never see the request at all.
   */
  serverSeq: number | null;
  /** The panel's tick, so the elapsed time actually moves. */
  now: number;
  busy: boolean;
  consent: boolean;
  onConsentChange: (next: boolean) => void;
  onUpgrade: () => void;
  onRefreshStatus: () => void;
}

export function ZosFirmwareUpdate({
  mode,
  zosFlashed,
  live,
  status,
  statusError,
  request,
  serverSeq,
  now,
  busy,
  consent,
  onConsentChange,
  onUpgrade,
  onRefreshStatus,
}: ZosFirmwareUpdateProps) {
  const { gate, note } = describeUpgradeGate(mode, zosFlashed);
  const watch = request === null
    ? null
    : describeUpgradeWatch({ request, live, serverSeq, now });

  return (
    <section className="zc-update" aria-label="固件更新">
      <SectionTitle>固件更新</SectionTitle>

      <div className="zc-update__body">
        {watch !== null && (
          <Surface
            variant="solid"
            outline
            color={watch.phase === "installing" ? "orange" : "brand"}
            className="zc-update__watch"
            contentClassName="zc-update__watch-content"
          >
            {/* One live region for the whole card: the device leaving and
                coming back is the only thing here that changes on its own. */}
            <p role="status" aria-live="polite">
              <strong>{watch.label}</strong>
              <span>{watch.detail}</span>
              <small>
                已过 {watch.elapsed}
                {watch.receipt === null ? "" : ` · ${watch.receipt}`}
              </small>
            </p>
          </Surface>
        )}

        {/* Mid-install the device is offline because that is what we asked it
            to do. The gate's "reconnect it first" is simply wrong at that
            moment, and it would evict the one card telling the truth — so an
            outstanding request silences the gate note rather than the reverse. */}
        {note !== null ? (watch === null && (
          // Each refusal has its own way out, so each says the way out rather
          // than a shared 不可用.
          <p
            className={gate === "offline" ? "zc-update__note" : "zc-update__note zc-update__note--muted"}
            role="status"
          >
            <Info aria-hidden="true" />
            <span><strong>{note.title}</strong>{note.detail}</span>
          </p>
        )) : (
          <>
            <ZosImageFacts
              status={status}
              statusError={statusError}
              now={now}
              busy={busy}
              onRefreshStatus={onRefreshStatus}
            />

            {status?.packed === true && (
              <div className="zc-update__decision">
                {/* Consent and the button it gates are one decision, grouped
                    like the sideload panel's: say what will happen, then ask. */}
                <label className="zc-update__consent">
                  <Checkbox
                    as="span"
                    className="zc-update__checkbox"
                    input
                    size="md"
                    color="brand"
                    checked={consent}
                    onChange={onConsentChange}
                  />
                  {/* One string per node: React SSR splits adjacent text
                      children with comment markers, which breaks copy asserts. */}
                  <span>
                    <strong>我知道更新期间会发生什么</strong>
                    时钟会下载镜像、写入 flash 并重启，期间面板会短暂无响应；断电会中断安装。
                  </span>
                </label>

                <div className="zc-update__actions">
                  <Button
                    type="button"
                    color="brand"
                    loading={busy}
                    disabled={!consent || busy || (watch !== null && watch.phase !== "returned")}
                    onClick={onUpgrade}
                  >
                    <HardDriveDownload />更新时钟固件
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ZosImageFacts({
  status,
  statusError,
  now,
  busy,
  onRefreshStatus,
}: {
  status: ZosFirmwareStatus | null;
  statusError: string | null;
  now: number;
  busy: boolean;
  onRefreshStatus: () => void;
}) {
  const reread = (
    <Button type="button" size="sm" variant="transparent" outline disabled={busy} onClick={onRefreshStatus}>
      <RefreshCw />重新读取
    </Button>
  );

  if (statusError !== null) {
    return (
      <div className="zc-update__image">
        <p className="zc-update__note zc-update__note--error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span><strong>读不到镜像信息</strong>{statusError}</span>
        </p>
        {reread}
      </div>
    );
  }

  if (status === null) {
    return (
      <p className="zc-update__note zc-update__note--muted" role="status">
        <Info aria-hidden="true" />
        <span>正在读取镜像信息…</span>
      </p>
    );
  }

  if (!status.packed) {
    // No image, no button. An entry point that can only fail when pressed is
    // worse than no entry point at all.
    return (
      <div className="zc-update__image">
        <p className="zc-update__note zc-update__note--muted" role="status">
          <Info aria-hidden="true" />
          <span>
            <strong>还没有打包镜像</strong>
            先在仓库里跑 <code className="zc-update__cmd">mise run os-image</code> 打一个，这一节才有东西可装。
          </span>
        </p>
        {reread}
      </div>
    );
  }

  const image = status.image;
  const size = formatImageBytes(image?.bytes ?? null);
  const age = describeImageAge(image?.builtAt ?? null, now);

  return (
    <div className="zc-update__image">
      <p className="zc-update__ready">
        <PackageCheck aria-hidden="true" />
        <strong>镜像已就绪</strong>
      </p>
      {/* A field the service did not send gets no row: an invented build id
          would be read as a real one. */}
      {(image?.buildId ?? null) === null && size === null && age === null ? null : (
        <dl className="zc-update__facts">
          {image?.buildId !== null && image?.buildId !== undefined && (
            <div><dt>版本</dt><dd>{image.buildId}</dd></div>
          )}
          {size !== null && <div><dt>大小</dt><dd>{size}</dd></div>}
          {age !== null && <div><dt>打包于</dt><dd>{age}</dd></div>}
        </dl>
      )}
      {reread}
    </div>
  );
}
