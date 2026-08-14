#include "net/FirmwareUpdate.h"

#include <spawn.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace tcos {

namespace {

// The nine bytes the on-device updater compares. Spelled out rather than
// derived from the full 16-byte "ZKSWEV1.0-180127" string, because the updater
// only ever looks at these and a stricter check here would refuse an image the
// device itself would happily flash.
const char kContainerMagic[FirmwareUpdate::kMagicBytes] = {'Z', 'K', 'S', 'W', 'E',
                                                           'V', '1', '.', '0'};

// Where staging may remount. A prefix rather than an exact match so
// "/mnt/storage/zkimg/" and "/mnt/storage/" are both covered by one rule.
const char kStorageMount[] = "/mnt/storage";

/**
 * Runs a binary to completion and reports a zero exit.
 *
 * posix_spawn rather than fork+exec or system(), for the reason
 * platform/DeviceWifi.cpp records at length: this app is loaded into zkgui,
 * whose address space measured ~230 MB on a box with 36 MB of RAM, and glibc
 * implements posix_spawn with clone(CLONE_VM|CLONE_VFORK) so it never
 * duplicates those page tables. A plain fork() here is a real allocation
 * failure, and it would happen at the worst possible moment.
 *
 * An empty environment rather than the process's: `mount` needs none, and
 * passing one fewer thing across the boundary is one fewer thing to reason
 * about on a path that ends in an erase of mtd3.
 */
bool spawnAndWait(const char* path, char* const argv[], int timeoutMs) {
  pid_t pid = -1;
  char* const env[] = {0};
  if (::posix_spawn(&pid, path, 0, 0, argv, env) != 0) return false;
  for (int waited = 0; waited < timeoutMs; waited += 20) {
    int status = 0;
    const pid_t done = ::waitpid(pid, &status, WNOHANG);
    if (done == pid) return WIFEXITED(status) && WEXITSTATUS(status) == 0;
    if (done < 0) return false;
    ::usleep(20000);
  }
  return false;
}

// Creates every missing component of `dir`. mkdir -p by hand: the alternative
// is spawning one, and this runs on a path where fewer moving parts is worth
// more than fewer lines.
bool ensureDir(const std::string& dir) {
  if (dir.empty()) return false;
  for (size_t i = 1; i <= dir.size(); ++i) {
    if (i < dir.size() && dir[i] != '/') continue;
    const std::string part = dir.substr(0, i);
    if (part == "/") continue;
    struct stat st;
    if (::stat(part.c_str(), &st) == 0) continue;
    if (::mkdir(part.c_str(), 0755) != 0) return false;
  }
  return true;
}

std::string joinDir(const std::string& dir, const char* name) {
  std::string out = dir;
  if (out.empty() || out[out.size() - 1] != '/') out += '/';
  out += name;
  return out;
}

}  // namespace

const char* FirmwareUpdate::describe(Verdict verdict) {
  switch (verdict) {
    case kOk: return "ok";
    case kNoServer: return "no-server";
    case kBadStatus: return "bad-status";
    case kNoLength: return "no-length";
    case kTooSmall: return "too-small";
    case kTooLarge: return "too-large";
    case kNotContainer: return "not-container";
    case kTruncated: return "truncated";
    case kWriteFailed: return "write-failed";
  }
  return "unknown";
}

std::string FirmwareUpdate::imagePath(const std::string& dir) {
  return joinDir(dir, imageName());
}

std::string FirmwareUpdate::partPath(const std::string& dir) {
  return joinDir(dir, partName());
}

bool FirmwareUpdate::needsWritableStorage(const std::string& dir) {
  const size_t n = sizeof(kStorageMount) - 1;
  if (dir.size() < n) return false;
  if (dir.compare(0, n, kStorageMount) != 0) return false;
  // "/mnt/storage" itself, or anything below it — but not "/mnt/storage-of-x".
  return dir.size() == n || dir[n] == '/';
}

bool FirmwareUpdate::discardStaged(const std::string& dir) {
  const std::string image = imagePath(dir);
  const std::string part = partPath(dir);
  struct stat st;
  const bool present = ::stat(image.c_str(), &st) == 0 || ::stat(part.c_str(), &st) == 0;
  if (!present) return true;

  const bool remount = needsWritableStorage(dir);
  if (remount && !remountStorage(true)) return false;
  ::unlink(image.c_str());
  ::unlink(part.c_str());
  ::sync();
  if (remount) remountStorage(false);
  return ::stat(image.c_str(), &st) != 0 && ::stat(part.c_str(), &st) != 0;
}

FirmwareUpdate::Verdict FirmwareUpdate::judgeHeader(int status, long declaredBytes) {
  // 200 exactly, not 2xx. A 204 or a 206 carries no whole image, and treating
  // "successful" as "complete" is the class of mistake that ends with a partial
  // container in flash.
  if (status != 200) return kBadStatus;
  // Without a length there is nothing to check completeness against, and the
  // only remaining evidence would be a clean TCP close — which a proxy or a
  // half-open connection produces just as readily as a finished transfer.
  if (declaredBytes < 0) return kNoLength;
  if (declaredBytes < kMinImageBytes) return kTooSmall;
  if (declaredBytes > kMaxImageBytes) return kTooLarge;
  return kOk;
}

bool FirmwareUpdate::looksLikeContainer(const char* head, size_t bytes) {
  if (head == 0 || bytes < static_cast<size_t>(kMagicBytes)) return false;
  return ::memcmp(head, kContainerMagic, kMagicBytes) == 0;
}

bool FirmwareUpdate::remountStorage(bool writable) {
  // Writable buffers because posix_spawn's argv is char* const[], not const.
  char mode[] = "remount,rw";
  if (!writable) mode[9] = 'o';
  char flag[] = "-o";
  char target[] = "/mnt/storage";

  // Absolute paths, tried in order, rather than posix_spawnp: the p variant
  // resolves against the CALLING process's PATH, and this app is loaded into
  // zkgui, whose environment is not ours to reason about. `mount` is a busybox
  // applet here (docs/research/tc002-device-probe.md lists it as present) and
  // busybox links its applets into more than one bin directory depending on the
  // build, so the fallback is what stops the whole feature from depending on
  // which one this image chose.
  static const char* kMountPaths[3] = {"/bin/mount", "/sbin/mount", "/system/bin/mount"};
  for (int i = 0; i < 3; ++i) {
    char binary[32];
    ::snprintf(binary, sizeof(binary), "%s", kMountPaths[i]);
    char* const argv[] = {binary, flag, mode, target, 0};
    if (spawnAndWait(binary, argv, 4000)) return true;
  }
  return false;
}

FirmwareUpdate::FirmwareUpdate()
    : mFile(0),
      mReceived(0),
      mTotal(0),
      mVerdict(kOk),
      mHeadBytes(0),
      mProgress(0),
      mProgressCtx(0) {}

FirmwareUpdate::~FirmwareUpdate() {
  // A partial that outlives this object is exactly what must never be left
  // behind, so the destructor is the last line of that defence rather than a
  // tidy-up.
  discard();
}

bool FirmwareUpdate::onReady(void* ctx, const HttpClient::Response& head, long declared) {
  return static_cast<FirmwareUpdate*>(ctx)->beginBody(head.status, declared);
}

bool FirmwareUpdate::onData(void* ctx, const char* bytes, size_t count) {
  return static_cast<FirmwareUpdate*>(ctx)->appendBody(bytes, count);
}

bool FirmwareUpdate::beginBody(int status, long declared) {
  // Judged BEFORE a file exists. Opening first and validating after would mean
  // an 8 MiB partial on a storage partition every time the service answered
  // with something else.
  mVerdict = judgeHeader(status, declared);
  if (mVerdict != kOk) return false;
  mTotal = declared;

  const std::string part = partPath(mDir);
  // "wb", so a partial left by an interrupted attempt is overwritten rather
  // than appended to. The name is fixed for the same reason the rename is
  // atomic: the updater must only ever be able to see a whole image.
  mFile = ::fopen(part.c_str(), "wb");
  if (mFile == 0) {
    mVerdict = kWriteFailed;
    return false;
  }
  return true;
}

bool FirmwareUpdate::appendBody(const char* bytes, size_t count) {
  if (mFile == 0 || count == 0) return mFile != 0;

  // The magic, buffered across reads: TCP is free to hand over the first nine
  // bytes in nine pieces, and a check that assumed otherwise would pass for
  // years and then let an HTML error page through on the one slow evening.
  if (mHeadBytes < static_cast<int>(sizeof(mHead))) {
    const size_t room = sizeof(mHead) - static_cast<size_t>(mHeadBytes);
    const size_t take = count < room ? count : room;
    ::memcpy(mHead + mHeadBytes, bytes, take);
    mHeadBytes += static_cast<int>(take);
    if (mHeadBytes >= kMagicBytes && !looksLikeContainer(mHead, static_cast<size_t>(mHeadBytes))) {
      mVerdict = kNotContainer;
      return false;
    }
  }

  if (::fwrite(bytes, 1, count, mFile) != count) {
    mVerdict = kWriteFailed;
    return false;
  }
  mReceived += static_cast<long>(count);
  if (mProgress != 0) mProgress(mProgressCtx, mReceived, mTotal);
  return true;
}

bool FirmwareUpdate::commit() {
  if (mFile == 0) return false;
  // Flushed and fsync'd BEFORE the rename, the way platform/Prefs does it: the
  // filesystem will happily rename an unflushed file, and the whole point of
  // the temporary is that the final name never exists in a half-written state.
  ::fflush(mFile);
  ::fsync(::fileno(mFile));
  ::fclose(mFile);
  mFile = 0;

  const std::string part = partPath(mDir);
  const std::string image = imagePath(mDir);
  if (::rename(part.c_str(), image.c_str()) != 0) {
    ::unlink(part.c_str());
    return false;
  }
  // And once more for the directory entry itself. What follows this call is a
  // reboot into the updater; a rename still in the page cache when that happens
  // is an image the updater cannot see.
  ::sync();
  return true;
}

void FirmwareUpdate::discard() {
  if (mFile != 0) {
    ::fclose(mFile);
    mFile = 0;
  }
  if (!mDir.empty()) ::unlink(partPath(mDir).c_str());
}

FirmwareUpdate::Verdict FirmwareUpdate::fetch(const std::string& url, const std::string& dir,
                                              int timeoutMs, ProgressFn progress,
                                              void* progressCtx) {
  mDir = dir;
  mFile = 0;
  mReceived = 0;
  mTotal = 0;
  mVerdict = kOk;
  mHeadBytes = 0;
  mProgress = progress;
  mProgressCtx = progressCtx;

  const bool remount = needsWritableStorage(dir);
  if (remount) remountStorage(true);
  // Not fatal on its own: a directory that already exists returns here too, and
  // the real verdict comes from whether the file can be opened.
  ensureDir(dir);

  HttpClient::Stream sink;
  sink.ready = &FirmwareUpdate::onReady;
  sink.data = &FirmwareUpdate::onData;
  sink.ctx = this;

  HttpClient::Response head;
  const bool ok = HttpClient::streamGet(url, &head, sink, timeoutMs);

  if (ok) {
    if (!commit()) mVerdict = kWriteFailed;
  } else {
    discard();
    // streamGet says only that the exchange did not complete; the reason may
    // already be recorded by a callback that refused. What is left is the two
    // failures no callback sees: never getting a reply, and losing the
    // connection with bytes still owed.
    if (mVerdict == kOk) {
      if (head.status < 0) {
        mVerdict = kNoServer;
      } else if (head.status != 200) {
        mVerdict = kBadStatus;
      } else {
        mVerdict = kTruncated;
      }
    }
  }

  // Put the mount back the way it was found, on success as well as failure.
  // The vendor's own update path never writes here — its documented recipe
  // stages in /tmp — so nothing downstream needs it writable, and /mnt/storage
  // is vfat on mtdblock7 (docs/research/tc002-device-probe.md): a journal-less
  // filesystem left mounted rw across the reboot that follows is the one
  // avoidable way this feature could damage something it was not aiming at.
  if (remount) remountStorage(false);
  return mVerdict;
}

}  // namespace tcos
