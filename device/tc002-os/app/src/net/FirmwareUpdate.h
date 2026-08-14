#ifndef NET_FIRMWAREUPDATE_H_
#define NET_FIRMWAREUPDATE_H_

#include <stdio.h>

#include <string>

#include "net/HttpClient.h"

namespace tcos {

/**
 * Downloading a firmware image from the console and staging it where the vendor
 * updater looks for one.
 *
 * WHY THIS EXISTS. Installing a new ZOS means writing mtd3 `res`, and the only
 * writer on this device is /lib/libzkupgrade.so, driven by
 * `UpgradeMonitor::checkUpgradeFile(dir)` — see tcos::upgradeEntryPoint(). That
 * call needs an image already sitting in `dir`, and until now the only way one
 * got there was a human running `adb push`. The device already pulls everything
 * else it renders over HTTP; the image is the last thing it could not.
 *
 * WHY /tmp AND NOT /mnt/storage/zkimg. This was the other way round, and the
 * hardware settled it. /mnt/storage is the UDISK partition (mtd7, 8.5 MB vfat)
 * the stock image itself sits on, which made it the obvious home: real storage,
 * the vendor's own staging directory, survives a reboot. Then this unit's copy
 * developed a bad region exactly where a 1 MB image lands. Measured: a staged
 * `update.img` failed to read back at the same 6 % offset twice, while an older
 * 2.7 MB file elsewhere on the same volume read fine, and the read error tripped
 * the volume's `errors=remount-ro` — after which the next download's rename AND
 * its fallback unlink both failed, and the vendor updater sat on an image it
 * could not read while the panel said 安装中 forever.
 *
 * tmpfs has no such failure mode, and the objection to it turns out to be an
 * argument for it. Yes it is RAM on a 36 MB device — but the image is ~1 MB
 * against 16.5 MB of /tmp and 17 MB available, it lives there only between the
 * download and the install a few seconds later, and a reboot CLEARS IT. That
 * last property is free correctness: the vendor chain does not delete what it
 * flashed, and an image left where the updater can find it is the entire reason
 * a device reinstalls on every boot. On tmpfs the spent image cannot outlive the
 * install that consumed it.
 *
 * /mnt/storage/zkimg is kept as upgradeEntryPoint()'s second candidate, so an
 * image staged there by hand still installs. Staging under it still remounts,
 * writes, and puts the mount back the way it was found.
 *
 * THE GUARD RAILS ARE THE POINT. What follows a successful download is an erase
 * of the partition the whole firmware boots from, and there is no recovery slot
 * and no A/B pair behind it (device/tc002-os/README.md). So:
 *
 *   - only a 200 with a declared length is a candidate; a 204, a redirect, a
 *     404 page or a chunked reply is refused before a file is opened;
 *   - a body shorter than a ZKSWE container header or larger than the partition
 *     is refused on the DECLARED length, before a byte is written;
 *   - the first bytes must actually be a ZKSWE container, so a service that
 *     answers 200 with an HTML error page cannot reach flash;
 *   - the bytes land in `update.img.part` and are renamed to `update.img` only
 *     once the last declared byte has arrived, so a dropped connection can
 *     never leave a truncated image where the updater will find one;
 *   - any failure unlinks the partial and returns a verdict, and the caller
 *     does not call the installer.
 *
 * Everything here is plain POSIX, so the whole class compiles and is asserted
 * on the build host against a scratch directory and a real HTTP server over
 * loopback — including the .part-then-rename discipline, which is the one
 * property that cannot be checked by looking at the device afterwards.
 */
class FirmwareUpdate {
 public:
  /**
   * Why an attempt ended. `kOk` is the ONLY value that may be followed by an
   * install; every other one is a reason to leave the flash alone.
   */
  enum Verdict {
    kOk = 0,
    kNoServer,      // never got a reply at all
    kBadStatus,     // answered, but not with 200
    kNoLength,      // 200 with no Content-Length: completeness is uncheckable
    kTooSmall,      // shorter than a container header
    kTooLarge,      // would not fit mtd3 res
    kNotContainer,  // the bytes do not begin ZKSWEV1.0
    kTruncated,     // fewer bytes arrived than the service declared
    kWriteFailed,   // staging storage refused the write or the rename
  };

  /** A short ASCII tag for the breadcrumb log; never user-facing. */
  static const char* describe(Verdict verdict);

  /**
   * Container geometry, from device/tc002-os/release/pack-image.ts, which
   * derives every one of these from the disassembly of the on-device
   * libzkupgrade.so and re-proves them against the stock image on every run.
   *
   * The minimum is the smallest header a container can have: 20 bytes of
   * prefix, one 28-byte item descriptor, and the 524-byte ei block. A file
   * shorter than that is not a short image, it is not an image.
   */
  static const long kMinImageBytes = 20 + 28 + 524;
  /** /proc/mtd: mtd3 res is 0x800000, and the updater rejects anything larger
   *  BEFORE it erases. Refusing it here means never finding out that way. */
  static const long kMaxImageBytes = 0x800000;
  /** memcmp(hdr, "ZKSWEV1.0", 9) at libzkupgrade 0x5540 — the same nine bytes
   *  the updater itself compares, so this check cannot be stricter than it. */
  static const int kMagicBytes = 9;

  /** The updater's first search directory, and the only one written here. */
  static const char* stagingDir() { return "/tmp/zkimg/"; }
  /** Where images used to be staged, and where a hand-pushed one may still be.
   *  Swept at startup so a device carrying the old layout does not keep an
   *  image the updater would happily install again on the next boot. */
  static const char* legacyStagingDir() { return "/mnt/storage/zkimg/"; }
  static const char* imageName() { return "update.img"; }
  static const char* partName() { return "update.img.part"; }

  static std::string imagePath(const std::string& dir);
  static std::string partPath(const std::string& dir);

  /**
   * Whether staging into `dir` has to remount anything.
   *
   * True only under /mnt/storage. That is what keeps the host self-check away
   * from `mount`: it stages into a scratch directory, so the remount branch is
   * not merely unused there, it is unreachable.
   */
  static bool needsWritableStorage(const std::string& dir);

  /**
   * Removes a spent `update.img` (and any `.part` left by a dropped transfer)
   * from `dir`. True when nothing of either name is left behind.
   *
   * The vendor updater does NOT delete what it flashed, and an image that
   * outlives its install is not inert: it is the standing invitation that turns
   * "install once" into a reinstall on every boot. Called from startup, where
   * anything still staged is by definition finished with — a download for a
   * live request cannot predate the worker thread that performs it.
   */
  static bool discardStaged(const std::string& dir);

  /** Pure: is this reply worth opening a file for? */
  static Verdict judgeHeader(int status, long declaredBytes);
  /** Pure: do these leading bytes begin a ZKSWE container? */
  static bool looksLikeContainer(const char* head, size_t bytes);

  /** Called as the body arrives, on the caller's worker thread. */
  typedef void (*ProgressFn)(void* ctx, long received, long total);

  FirmwareUpdate();
  ~FirmwareUpdate();

  /**
   * Downloads `url` into `dir` and, only on kOk, leaves `<dir>update.img` whole.
   *
   * Blocking, and meant to be called from HostLink's worker thread — never from
   * the UI tick. `timeoutMs` is HttpClient's per-read budget, not a total.
   */
  Verdict fetch(const std::string& url, const std::string& dir, int timeoutMs,
                ProgressFn progress, void* progressCtx);

  long received() const { return mReceived; }
  long total() const { return mTotal; }

 private:
  FirmwareUpdate(const FirmwareUpdate&);
  FirmwareUpdate& operator=(const FirmwareUpdate&);

  // The HttpClient::Stream thunks, and the two members they drive.
  static bool onReady(void* ctx, const HttpClient::Response& head, long declared);
  static bool onData(void* ctx, const char* bytes, size_t count);
  bool beginBody(int status, long declared);
  bool appendBody(const char* bytes, size_t count);
  /** fsync, rename over the real name, sync. */
  bool commit();
  /** Close and unlink the partial, whatever state it is in. */
  void discard();

  /** `mount -o remount,{rw|ro} /mnt/storage`, via posix_spawn. */
  static bool remountStorage(bool writable);

  std::string mDir;
  FILE* mFile;
  long mReceived;
  long mTotal;
  Verdict mVerdict;
  int mHeadBytes;                 // how much of mHead is filled
  char mHead[16];                 // the container magic, buffered across reads
  ProgressFn mProgress;
  void* mProgressCtx;
};

}  // namespace tcos

#endif  // NET_FIRMWAREUPDATE_H_
