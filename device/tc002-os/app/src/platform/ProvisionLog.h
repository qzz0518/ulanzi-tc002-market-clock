#ifndef PLATFORM_PROVISIONLOG_H_
#define PLATFORM_PROVISIONLOG_H_

#include <pthread.h>

#include <string>

namespace tcos {

/**
 * The provisioning breadcrumb trail: /data/zos-provision.log.
 *
 * This file IS the debug channel for the hotspot. The moment provisioning
 * starts, the radio leaves the LAN and adb dies with it; logcat is banned
 * outright on this unit (it wedges adbd, see device/tc002-os/README.md); and
 * the only way back in — power-cycle onto WiFi — ERASES /tmp. So the first
 * generation of diagnostics, all of it on tmpfs, self-destructed on the way to
 * its only reader. Everything here therefore lands on /data (jffs2, survives
 * the power cycle and the reflash), and every line is fsync'd, because a line
 * still in the page cache when the plug is pulled never happened.
 *
 * Line format, one event per line, written for a stranger:
 *
 *   <seq> <monotonic-ms-since-boot> <TAG> k=v k=v...
 *
 * seq makes truncation visible (a gap is a gap, not a mystery), the timestamp
 * orders events across the supplicant/hostapd handover where wall time does
 * not exist yet, and the fields are flat key=value so `grep DNSMASQ` is a
 * complete query language.
 *
 * SECRETS. This API deliberately has no way to receive one: callers pass a tag
 * and pre-redacted fields, the one call site that ever holds the user's PSK
 * (DeviceProvisioning::submit) writes the literal `psk=redacted`, and
 * sanitize() cannot un-redact anything because redaction happens before the
 * string is built. Grep for `psk=` in a pulled log: the only hit must be that
 * literal.
 *
 * BUDGET. jffs2 on a device with ~1 MB free RAM and the user's credentials one
 * directory over: the file rotates at kRotateBytes to a single `.1`
 * generation, and the chatty call sites (the portal's 2 s poll, the address
 * reconciliation) log only on CHANGE, so a device stuck in provisioning for a
 * night cannot eat the partition.
 */
class ProvisionLog {
 public:
  /** Paths and the rotation budget are injectable so the host check can run
   *  the real append/rotate code against a scratch directory. */
  ProvisionLog(const std::string& path, const std::string& rotatedPath, int rotateBytes);
  ~ProvisionLog();

  void log(const char* tag);
  void log(const char* tag, const std::string& fields);

  /** The device-wide instance on /data. First touched from onUI_init on the UI
   *  thread, before any network worker exists, so the local-static guard in the
   *  implementation is never actually raced. */
  static ProvisionLog& device();

  static const char* devicePath() { return "/data/zos-provision.log"; }
  static const char* deviceRotatedPath() { return "/data/zos-provision.log.1"; }
  /** Where the boot stamp goes: proof of WHICH build is flashed, written
   *  compare-first on every boot. Kills hypothesis zero ("the fix was never
   *  actually flashed") before any other line is trusted. */
  static const char* buildIdPath() { return "/data/zos-build.id"; }
  /** The console request id we have already INSTALLED, kept across reboots.
   *  In memory it is worthless: the install ends in a reboot, the counter comes
   *  back as 0, the document still carries the same request — and the device
   *  installs the same image again, forever. `/data` is mtd6 and survives the
   *  mtd3 write, which is the whole reason this can live here. */
  static const char* upgradeSeqPath() { return "/data/zos-upgrade.seq"; }
  static const int kRotateBytes = 32 * 1024;

  /** `ZOS_BUILD_ID` injected by the build (git rev + stamp), or
   *  "dev-unstamped" for a build that skipped the injection. */
  static const char* buildId();

  // Pure halves, asserted on the host.
  static std::string sanitize(const std::string& value);
  static std::string formatLine(int seq, long upMs, const char* tag,
                                const std::string& fields);

  /** Compare-first write, for the boot stamp: /data is jffs2 and an identical
   *  body must cost a read, not a write. Returns false only when the write was
   *  needed and failed. */
  static bool writeFileIfChanged(const char* path, const std::string& body);

 private:
  ProvisionLog(const ProvisionLog&);
  ProvisionLog& operator=(const ProvisionLog&);

  pthread_mutex_t mLock;
  int mSeq;
  std::string mPath;
  std::string mRotated;
  int mRotateBytes;
  long mEpochMs;
};

}  // namespace tcos

#endif  // PLATFORM_PROVISIONLOG_H_
