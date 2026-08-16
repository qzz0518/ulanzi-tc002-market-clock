import { useRef } from "react";
import { CircleAlert, HardDriveDownload, Info, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button, Checkbox, Surface } from "@cladd-ui/react";
import type { FirmwareMode } from "@/lib/firmware-mode";
import {
  ZOS_FIRMWARE_MAX_BYTES,
  describeFirmwareSource,
  describeUpgradeGate,
  describeUpgradeWatch,
  firmwareFactRows,
  formatImageBytes,
  type ZosFirmwareStatus,
  type ZosUpgradeRequest,
} from "@/lib/zos-link";

// The console's side of a firmware install, as a section of 常规设置: say what
// image is armed and where it came from, let the owner replace it with one of
// their own, take one explicit consent, and then report only what can actually
// be observed.
//
// TWO ACTS, NOT ONE. Uploading an image and installing it are separate on
// purpose. "The upload succeeded" and "this is the build I meant" are different
// claims, and only the second one ends in an erase of mtd3 — a partition with no
// A/B pair and no recovery slot behind it. So an upload never starts an install;
// it shows the owner what arrived and waits.
//
// What can be observed of the install itself is thin, by design. The vendor
// updater tears every service down, writes flash and reboots, so the device
// stops answering halfway through and there is no progress to read. This section
// therefore never says 更新成功 — it says the request went out, the device went
// quiet, the device came back. Which build ended up in flash is the clock's to
// show, and announcing it from here would hide the failure most worth seeing: a
// device that comes back on the old build.

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
  /** The dialog's tick, so the elapsed time actually moves. */
  now: number;
  busy: boolean;
  /** A file is on its way to the service. Separate from `busy`: it disables a
   * different button, and the two can never be in flight together. */
  uploading: boolean;
  consent: boolean;
  onConsentChange: (next: boolean) => void;
  onUpgrade: () => void;
  onRefreshStatus: () => void;
  onUpload: (file: File) => void;
  onRemoveUpload: () => void;
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
  uploading,
  consent,
  onConsentChange,
  onUpgrade,
  onRefreshStatus,
  onUpload,
  onRemoveUpload,
}: ZosFirmwareUpdateProps) {
  const { gate, note } = describeUpgradeGate(mode, zosFlashed);
  const watch = request === null
    ? null
    : describeUpgradeWatch({ request, live, serverSeq, now });
  // A clock that is not running ZOS at all has nothing to update and no image
  // worth managing — that is the one gate that hides the whole section. An
  // OFFLINE ZOS keeps it: preparing the image needs the service, not the device,
  // and the owner can upload now and install when the clock is back.
  const showsImage = gate !== "foreign";

  return (
    <div className="device-settings-fields">
      {watch !== null && (
        <div className="device-settings-note zos-fw__watch-slot">
          <Surface
            variant="solid"
            outline
            color={watch.phase === "installing" ? "orange" : "brand"}
            contentClassName="zos-fw__watch"
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
        </div>
      )}

      {/* Mid-install the device is offline because that is what we asked it to
          do. The gate's "reconnect it first" is simply wrong at that moment, and
          it would evict the one card telling the truth — so an outstanding
          request silences the gate note rather than the reverse. */}
      {note !== null && watch === null && (
        // Each refusal has its own way out, so each says the way out rather
        // than a shared 不可用.
        <p className="device-settings-note zos-fw__note" role="status">
          <Info aria-hidden="true" />
          <span><strong>{note.title}</strong>{note.detail}</span>
        </p>
      )}

      {showsImage && (
        <>
          <ZosImageFacts
            status={status}
            statusError={statusError}
            now={now}
            busy={busy}
            onRefreshStatus={onRefreshStatus}
          />

          <UploadRow
            status={status}
            uploading={uploading}
            busy={busy}
            onUpload={onUpload}
            onRemoveUpload={onRemoveUpload}
          />

          {gate === "ready" && status?.packed === true && (
            <div className="device-settings-note zos-fw__decision">
              {/* Consent and the button it gates are one decision, grouped like
                  the sideload panel's: say what will happen, then ask. */}
              <label className="zos-fw__consent">
                <Checkbox
                  as="span"
                  className="zos-fw__checkbox"
                  input
                  size="md"
                  color="brand"
                  checked={consent}
                  onChange={onConsentChange}
                />
                {/* One string per node: React SSR splits adjacent text children
                    with comment markers, which breaks copy asserts. */}
                <span>
                  <strong>我知道更新期间会发生什么</strong>
                  时钟会下载镜像、写入 flash 并重启，期间面板会短暂无响应；断电会中断安装。
                </span>
              </label>

              <div className="zos-fw__actions">
                <Button
                  type="button"
                  color="brand"
                  loading={busy}
                  disabled={!consent || busy || uploading || (watch !== null && watch.phase !== "returned")}
                  onClick={onUpgrade}
                >
                  <HardDriveDownload />安装到时钟
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What is armed, read off the service's disk.
 *
 * Every row here is derived from the bytes that will actually be written — size,
 * the digest of the whole file, the partition it targets — because this is the
 * last screen between a file somebody picked and an erase of mtd3.
 */
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
  // 只在它确实是「下一步」的两种处境里出现：读失败，和还没有镜像（人可能刚在
  // 另一个窗口里打完包）。有镜像的时候，对话框脚上那颗「重新读取」已经把这一页
  // 全部重读一遍了——同一句话在一屏里摆两遍，是家具，不是功能。
  const reread = (
    <Button type="button" size="sm" variant="transparent" outline disabled={busy} onClick={onRefreshStatus}>
      <RefreshCw />重新读取
    </Button>
  );

  if (statusError !== null) {
    return (
      <div className="device-settings-note zos-fw__state">
        <p className="zos-fw__note zos-fw__note--error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span><strong>读不到镜像信息</strong>{statusError}</span>
        </p>
        {reread}
      </div>
    );
  }

  if (status === null) {
    return (
      <p className="device-settings-note zos-fw__note" role="status">
        <Info aria-hidden="true" />
        <span>正在读取镜像信息…</span>
      </p>
    );
  }

  if (!status.packed) {
    // No image, no install button. An entry point that can only fail when
    // pressed is worse than no entry point at all — the upload row below is
    // what this state actually offers.
    return (
      <div className="device-settings-note zos-fw__state">
        <p className="zos-fw__note" role="status">
          <Info aria-hidden="true" />
          <span>
            <strong>还没有可安装的镜像</strong>
            上传一份 .img，或者在仓库里跑 <code className="zos-fw__cmd">mise run os-image</code> 打一份。
          </span>
        </p>
        {reread}
      </div>
    );
  }

  const source = describeFirmwareSource(status.source, now);
  const rows = firmwareFactRows(status.image, now);
  const shadowed = status.shadowedPacked;

  return (
    <>
      {/* Same read-only row markup as 设备状态 above it: one clock, one table
          shape. */}
      <dl className="device-settings-fields device-info-list">
        <div className="device-setting-field">
          <div className="device-setting-copy">
            <dt>来源</dt>
            <p>{source.detail}</p>
          </div>
          <dd className="device-setting-control device-info-value">{source.label}</dd>
        </div>
        {rows.map((row) => (
          <div key={row.key} className="device-setting-field">
            <div className="device-setting-copy">
              <dt>{row.label}</dt>
              {row.note && <p>{row.note}</p>}
            </div>
            <dd className="device-setting-control device-info-value zos-fw__value">{row.value}</dd>
          </div>
        ))}
      </dl>
      {shadowed !== null && (
        // Never silent about this. `mise run os-image` runs on every build, and
        // somebody who has just run it needs to know their build is on disk and
        // is NOT the one that will be installed.
        <p className="device-settings-note zos-fw__note" role="status">
          <Info aria-hidden="true" />
          <span>
            <strong>本地打包的镜像没有被选中</strong>
            仓库里还有一份 {formatImageBytes(shadowed.bytes) ?? "本地打包"} 的镜像；要装它，先移除上传的这一份。
          </span>
        </p>
      )}
    </>
  );
}

/** Picking a file, and taking it back. Neither one installs anything. */
function UploadRow({
  status,
  uploading,
  busy,
  onUpload,
  onRemoveUpload,
}: {
  status: ZosFirmwareStatus | null;
  uploading: boolean;
  busy: boolean;
  onUpload: (file: File) => void;
  onRemoveUpload: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploaded = status?.source?.kind === "upload";

  return (
    <div className="device-setting-field">
      <div className="device-setting-copy">
        <label id="zos-firmware-upload-label" htmlFor="zos-firmware-upload">上传镜像</label>
        {/* 一个文本节点：JSX 换行会在两句中间留一个空格，中文里那是个多余的洞。 */}
        <p>{`选一份 .img（ZKSWE 容器，最大 ${formatImageBytes(ZOS_FIRMWARE_MAX_BYTES)}）。上传只是准备镜像，不会开始安装。`}</p>
      </div>
      <div className="device-setting-control zos-fw__upload">
        <input
          ref={inputRef}
          id="zos-firmware-upload"
          aria-labelledby="zos-firmware-upload-label"
          type="file"
          accept=".img,application/octet-stream"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear the input so picking the same file twice still fires: a
            // re-upload after a failed one is the likeliest next action.
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
        <Button
          type="button"
          color="neutral"
          loading={uploading}
          disabled={uploading || busy}
          onClick={() => inputRef.current?.click()}
        >
          <Upload />选择镜像文件
        </Button>
        {uploaded && (
          <Button
            type="button"
            size="sm"
            color="neutral"
            variant="transparent"
            outline
            disabled={uploading || busy}
            onClick={onRemoveUpload}
          >
            <Trash2 />移除上传
          </Button>
        )}
      </div>
    </div>
  );
}
