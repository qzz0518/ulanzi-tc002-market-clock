#include "platform/ProvisionLog.h"

#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// Injected by the build as -DZOS_BUILD_ID='"<rev>-<stamp>"' (see
// flythings-build/Makefile, which also forces this one object stale on every
// invocation — a build id that can go stale would un-kill the exact hypothesis
// it exists to kill). The fallback names itself honestly rather than guessing.
#ifndef ZOS_BUILD_ID
#define ZOS_BUILD_ID "dev-unstamped"
#endif

namespace tcos {

namespace {

long monotonicMsNow() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<long>(ts.tv_sec) * 1000L + ts.tv_nsec / 1000000L;
}

}  // namespace

const char* ProvisionLog::buildId() { return ZOS_BUILD_ID; }

ProvisionLog::ProvisionLog(const std::string& path, const std::string& rotatedPath,
                           int rotateBytes)
    : mSeq(0),
      mPath(path),
      mRotated(rotatedPath),
      mRotateBytes(rotateBytes),
      mEpochMs(monotonicMsNow()) {
  ::pthread_mutex_init(&mLock, 0);
}

ProvisionLog::~ProvisionLog() { ::pthread_mutex_destroy(&mLock); }

ProvisionLog& ProvisionLog::device() {
  static ProvisionLog sLog(devicePath(), deviceRotatedPath(), kRotateBytes);
  return sLog;
}

std::string ProvisionLog::sanitize(const std::string& value) {
  std::string out = value;
  for (size_t i = 0; i < out.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(out[i]);
    // One event, one line, forever: a newline smuggled in through an SSID off
    // the air must not be able to fake a second event, and a control byte must
    // not turn the pulled file into something a terminal mangles.
    if (c == '\n' || c == '\r' || c == '\t') {
      out[i] = ' ';
    } else if (c < 0x20) {
      out[i] = '?';
    }
  }
  return out;
}

std::string ProvisionLog::formatLine(int seq, long upMs, const char* tag,
                                     const std::string& fields) {
  char head[48];
  ::snprintf(head, sizeof(head), "%d %ld ", seq, upMs);
  std::string out(head);
  out += tag;
  if (!fields.empty()) {
    out += ' ';
    out += sanitize(fields);
  }
  out += '\n';
  return out;
}

void ProvisionLog::log(const char* tag) { log(tag, std::string()); }

void ProvisionLog::log(const char* tag, const std::string& fields) {
  ::pthread_mutex_lock(&mLock);
  const std::string line = formatLine(++mSeq, monotonicMsNow() - mEpochMs, tag, fields);

  // Rotate BEFORE the append, keeping exactly one older generation: the tail of
  // the previous session is often the half that explains the current one, and a
  // second generation would double the flash budget for no second reader.
  struct stat st;
  if (::stat(mPath.c_str(), &st) == 0 && st.st_size >= mRotateBytes) {
    ::rename(mPath.c_str(), mRotated.c_str());
  }

  const int fd = ::open(mPath.c_str(), O_WRONLY | O_APPEND | O_CREAT, 0644);
  if (fd >= 0) {
    // Best effort by design: a full /data must degrade to a missing line, never
    // to a blocked radio worker. The seq number is what makes the gap visible.
    (void)::write(fd, line.data(), line.size());
    // fsync per line ON PURPOSE. The only reader this file has reads it AFTER a
    // power cycle — that is the entire design — and a line still in the page
    // cache when the plug is pulled never happened. Event rate is a handful of
    // lines per provisioning session, so the flash cost is noise.
    ::fsync(fd);
    ::close(fd);
  }
  ::pthread_mutex_unlock(&mLock);
}

bool ProvisionLog::writeFileIfChanged(const char* path, const std::string& body) {
  FILE* existing = ::fopen(path, "rb");
  if (existing != 0) {
    std::string current;
    char buf[256];
    size_t n;
    while ((n = ::fread(buf, 1, sizeof(buf), existing)) > 0) current.append(buf, n);
    ::fclose(existing);
    if (current == body) return true;
  }
  FILE* f = ::fopen(path, "wb");
  if (f == 0) return false;
  const bool ok = ::fwrite(body.data(), 1, body.size(), f) == body.size();
  if (ok) ::fsync(::fileno(f));
  ::fclose(f);
  return ok;
}

}  // namespace tcos
