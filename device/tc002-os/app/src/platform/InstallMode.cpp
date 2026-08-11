#include "platform/InstallMode.h"

#include <sys/stat.h>

namespace tcos {
namespace install {

namespace {

// Written by device/tc002-os/sideload/os. Present only in a sideloaded session,
// because /tmp is tmpfs and a flashed boot starts with it empty.
const char* kSessionIdPath = "/tmp/tc002-sideload.id";
const char* kGuardPath = "/tmp/zos-allow-link";

bool exists(const char* path) {
  struct stat info;
  return ::stat(path, &info) == 0;
}

}  // namespace

bool isSideloaded() { return exists(kSessionIdPath); }

bool decide(bool sideloaded, bool guardPresent) {
  if (!sideloaded) return true;
  return guardPresent;
}

bool linkChangesAllowed() {
  // Never cached. The guard is meant to be created and removed by hand between
  // experiments, and a cached answer would make it look like it had not worked.
  return decide(isSideloaded(), exists(kGuardPath));
}

const char* refusalReason() {
  // Only ever consulted after a refusal, so the sideloaded case is the only one
  // that can produce it — but say something honest rather than assert.
  return isSideloaded() ? "link-locked" : "link-error";
}

}  // namespace install
}  // namespace tcos
