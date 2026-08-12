#include "platform/Prefs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <map>
#include <string>

#include "base/log.h"

namespace tcos {
namespace prefs {

namespace {

const char* kPath = "/data/zos-prefs.ini";
const char* kTempPath = "/data/zos-prefs.ini.tmp";

std::map<std::string, int>& table() {
  static std::map<std::string, int> single;
  return single;
}

bool& loadedFlag() {
  static bool single = false;
  return single;
}

bool& dirtyFlag() {
  static bool single = false;
  return single;
}

void loadOnce() {
  if (loadedFlag()) return;
  loadedFlag() = true;

  FILE* f = ::fopen(kPath, "r");
  if (f == 0) return;  // first boot; every getInt falls back
  char line[128];
  while (::fgets(line, sizeof(line), f) != 0) {
    char* eq = ::strchr(line, '=');
    if (eq == 0) continue;
    *eq = '\0';
    // Values are written by us and are plain integers, but a corrupted line
    // must not take the rest of the file down with it — skip it and keep going.
    const char* valueText = eq + 1;
    char* end = 0;
    const long value = ::strtol(valueText, &end, 10);
    if (end == valueText) continue;
    table()[std::string(line)] = static_cast<int>(value);
  }
  ::fclose(f);
}

}  // namespace

int getInt(const char* key, int fallback) {
  loadOnce();
  const std::map<std::string, int>::const_iterator it = table().find(std::string(key));
  return it == table().end() ? fallback : it->second;
}

void setInt(const char* key, int value) {
  loadOnce();
  const std::string name(key);
  const std::map<std::string, int>::const_iterator it = table().find(name);
  if (it != table().end() && it->second == value) return;  // no write, no wear
  table()[name] = value;
  dirtyFlag() = true;
}

bool dirty() { return dirtyFlag(); }

bool commit() {
  if (!dirtyFlag()) return true;

  FILE* f = ::fopen(kTempPath, "w");
  if (f == 0) {
    LOGE_TRACE("prefs: cannot open %s", kTempPath);
    return false;
  }
  for (std::map<std::string, int>::const_iterator it = table().begin(); it != table().end();
       ++it) {
    ::fprintf(f, "%s=%d\n", it->first.c_str(), it->second);
  }
  // Force it out before the rename: jffs2 will happily give us a rename over an
  // unflushed file, and the whole point of the temporary is to never leave a
  // half-written prefs file behind a power cut.
  ::fflush(f);
  ::fsync(::fileno(f));
  ::fclose(f);

  if (::rename(kTempPath, kPath) != 0) {
    LOGE_TRACE("prefs: rename failed");
    ::unlink(kTempPath);
    return false;
  }
  dirtyFlag() = false;
  return true;
}

}  // namespace prefs
}  // namespace tcos
