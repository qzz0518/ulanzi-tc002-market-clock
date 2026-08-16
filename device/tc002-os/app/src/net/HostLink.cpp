#include "net/HostLink.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "net/FirmwareUpdate.h"
#include "platform/ProvisionLog.h"
#include "net/HttpClient.h"

namespace tcos {

namespace {

uint64_t monoMs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000ull +
         static_cast<uint64_t>(ts.tv_nsec / 1000000);
}

// Percent-encodes the few characters an app name could legally contain that
// would otherwise terminate the query. App names are validated host-side to
// [A-Za-z0-9_-], so this is belt-and-braces rather than the main defence.
std::string queryEscape(const std::string& value) {
  std::string out;
  for (size_t i = 0; i < value.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(value[i]);
    const bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                      (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
    if (safe) {
      out.push_back(static_cast<char>(c));
    } else {
      char buf[4];
      ::snprintf(buf, sizeof(buf), "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

std::string jsonEscape(const std::string& value) {
  std::string out;
  for (size_t i = 0; i < value.size(); ++i) {
    const char c = value[i];
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(c);
    } else if (static_cast<unsigned char>(c) < 0x20) {
      out.push_back(' ');
    } else {
      out.push_back(c);
    }
  }
  return out;
}

// Free memory, so the console can see the device approaching the edge rather
// than discovering it by way of a restart. Absent on the build host, where this
// reports 0 and nothing depends on it.
int freeKb() {
  FILE* f = ::fopen("/proc/meminfo", "r");
  if (f == 0) return 0;
  char line[128];
  int value = 0;
  while (::fgets(line, sizeof(line), f) != 0) {
    if (::strncmp(line, "MemAvailable:", 13) == 0 || ::strncmp(line, "MemFree:", 8) == 0) {
      const char* p = ::strchr(line, ':');
      if (p != 0) value = ::atoi(p + 1);
      if (::strncmp(line, "MemAvailable:", 13) == 0) break;  // prefer it when present
    }
  }
  ::fclose(f);
  return value;
}

}  // namespace

HostLink::HostLink()
    : mRunning(false),
      mThreadsStarted(false),
      mWantSeq(0),
      mHaveSeq(0),
      mFetchingSeq(0),
      mFetchFailed(false),
      mPendingReady(false),
      mUpgradeArmedSeq(0),
      mUpgradeStartedSeq(0),
      mUpgradeInstallReady(false),
      mUpgradeSeqPath(ProvisionLog::upgradeSeqPath()),
      mBleOpenArmedSeq(0),
      mBleOpenPendingSeq(0),
      mMirrorDirty(false),
      mTelRestarts(0),
      mTelBattery(-1),
      mTelBatteryMv(-1),
      mTelCharging(false),
      mTelFlashed(false),
      mTelSleepOn(false),
      mTelSleepStartMin(0),
      mTelSleepEndMin(0),
      mTelSleepIdleSec(0),
      mTelSleepAsleep(false),
      mTelSleepClockSynced(false),
      mTelDirty(false) {
  ::pthread_mutex_init(&mLock, 0);
}

HostLink::~HostLink() {
  stop();
  ::pthread_mutex_destroy(&mLock);
}

void HostLink::start(const std::string& baseUrl) {
  if (mThreadsStarted) return;
  mBaseUrl = baseUrl;
  if (mBaseUrl.empty()) return;
  // Trailing slashes would produce "//api/os/pull", which Bun answers with a
  // 404 rather than a redirect.
  while (!mBaseUrl.empty() && mBaseUrl[mBaseUrl.size() - 1] == '/') {
    mBaseUrl.erase(mBaseUrl.size() - 1);
  }
  mRunning = true;
  mThreadsStarted = true;
  ::pthread_create(&mPullThread, 0, &HostLink::pullMain, this);
  ::pthread_create(&mWorkerThread, 0, &HostLink::workerMain, this);
}

void HostLink::stop() {
  if (!mThreadsStarted) return;
  mRunning = false;
  // Both loops check mRunning between requests; the longest wait is one pull
  // timeout, which is bounded and happens once at shutdown.
  ::pthread_join(mPullThread, 0);
  ::pthread_join(mWorkerThread, 0);
  mThreadsStarted = false;
}

void* HostLink::pullMain(void* self) {
  static_cast<HostLink*>(self)->runPull();
  return 0;
}

void* HostLink::workerMain(void* self) {
  static_cast<HostLink*>(self)->runWorker();
  return 0;
}

void HostLink::runPull() {
  int seq = 0;
  int backoffMs = 1000;
  while (mRunning) {
    char url[256];
    ::snprintf(url, sizeof(url), "%s/api/os/pull?seq=%d", mBaseUrl.c_str(), seq);

    HttpClient::Response response;
    const bool ok = HttpClient::get(url, &response, kPullTimeoutMs) && response.ok();

    StateDoc doc;
    if (ok && doc.parse(response.body)) {
      seq = doc.seq();
      backoffMs = 1000;
      adoptDocument(doc, monoMs());
      continue;  // straight back into the hold; no sleep on the happy path
    }

    ::pthread_mutex_lock(&mLock);
    ++mSnapshot.consecutiveFailures;
    // Three misses rather than one: a single failed poll is the normal shape of
    // a router hiccup, and flashing "offline" on the panel for it would train
    // the user to ignore the indicator.
    if (mSnapshot.consecutiveFailures >= 3) mSnapshot.online = false;
    ::pthread_mutex_unlock(&mLock);

    // The seq is deliberately kept: if the service merely restarted its socket
    // the next poll resumes where this one left off instead of replaying.
    for (int slept = 0; slept < backoffMs && mRunning; slept += 100) ::usleep(100000);
    if (backoffMs < 10000) backoffMs *= 2;
  }
}

void HostLink::runWorker() {
  uint64_t lastMirrorMs = 0;
  uint64_t lastReportMs = 0;
  const uint64_t startedMs = monoMs();
  // Which request last failed, and when it may be tried again. Worker-thread
  // locals: only this thread reads or writes them, so they need no lock even
  // though they are consulted inside one.
  int failedSeq = 0;
  uint64_t retryAtMs = 0;

  while (mRunning) {
    const uint64_t loopMs = monoMs();

    // --- channel frames ----------------------------------------------------
    std::string fetch;
    int fetchSeq = 0;
    ::pthread_mutex_lock(&mLock);
    if (!mWantApp.empty() && mWantSeq != mHaveSeq && mWantSeq != mFetchingSeq &&
        (mWantSeq != failedSeq || loopMs >= retryAtMs)) {
      fetch = mWantApp;
      fetchSeq = mWantSeq;
      mFetchingSeq = fetchSeq;
    }
    ::pthread_mutex_unlock(&mLock);

    if (!fetch.empty()) {
      char url[320];
      ::snprintf(url, sizeof(url), "%s/api/os/frames?app=%s", mBaseUrl.c_str(),
                 queryEscape(fetch).c_str());
      HttpClient::Response response;
      FrameBundle bundle;
      const bool ok = HttpClient::get(url, &response, kFrameTimeoutMs) &&
                      response.ok() && bundle.parse(response.body);
      // What the service says it just served, which outranks what the document
      // advertised: a save landing between the two would otherwise leave the
      // device believing its fresh bundle is already stale.
      const std::string servedRev = ok ? response.header("x-os-rev") : std::string();

      ::pthread_mutex_lock(&mLock);
      mFetchingSeq = 0;
      if (ok) {
        // Swap rather than assign: the bundle is up to ~900 KB and this runs on
        // a device with ~1 MB free, so a copy is not merely slow but fatal.
        mPending.swap(bundle);
        mPendingReady = true;
        mHaveApp = fetch;
        mPendingRev = servedRev.empty() ? mWantRev : servedRev;
        mHaveSeq = fetchSeq;
        mFetchFailed = false;
      } else {
        mFetchFailed = true;
        // Leave mHaveApp and mHaveSeq alone: a failed refresh must not blank a
        // channel that is already on screen, and the request stays outstanding
        // so it is retried — but not before kFetchRetryMs, or a service that
        // refuses the connection turns this into a spin.
        failedSeq = fetchSeq;
        retryAtMs = monoMs() + (uint64_t)kFetchRetryMs;
      }
      ::pthread_mutex_unlock(&mLock);
    }

    // --- firmware image ----------------------------------------------------
    //
    // On this thread, and not on a fourth one, for the reason the frame fetch
    // is here: an ~1 MB download is the same shape of job, and a thread that
    // exists to be blocked once in the life of a device is a thread that is
    // never exercised. What it costs is honest — the mirror and the telemetry
    // stall for the length of the download, so the console's preview freezes
    // while the panel keeps rendering — and it is bounded by the fact that the
    // device reboots into the new firmware immediately afterwards.
    const int upgradeSeq = takeUpgradeRequest();
    if (upgradeSeq != 0) runUpgrade(upgradeSeq);

    // --- transport commands ------------------------------------------------
    // Drained before the mirror so a button press is not stuck behind a frame
    // upload: the mirror can miss a frame, a press cannot miss at all.
    std::vector<std::string> actions;
    ::pthread_mutex_lock(&mLock);
    actions.swap(mActions);
    ::pthread_mutex_unlock(&mLock);
    for (size_t i = 0; i < actions.size(); ++i) {
      const std::string body = "{\"action\":\"" + actions[i] + "\"}";
      HttpClient::Response response;
      HttpClient::perform(mBaseUrl + "/api/music/device/report", "POST",
                          "application/json", body, &response, 5000);
    }

    const uint64_t now = monoMs();

    // --- mirror ------------------------------------------------------------
    bool wantMirror = false;
    std::string frame;
    if (now - lastMirrorMs >= static_cast<uint64_t>(kMirrorIntervalMs)) {
      ::pthread_mutex_lock(&mLock);
      if (mSnapshot.mirrorWanted && mMirrorDirty && !mMirrorFrame.empty()) {
        frame.assign(reinterpret_cast<const char*>(&mMirrorFrame[0]), mMirrorFrame.size());
        mMirrorDirty = false;
        wantMirror = true;
      }
      ::pthread_mutex_unlock(&mLock);
    }
    if (wantMirror) {
      lastMirrorMs = now;
      HttpClient::Response response;
      HttpClient::perform(mBaseUrl + "/api/os/mirror", "POST",
                          "application/octet-stream", frame, &response, 4000);
      // The reply is how the device learns the console closed, without waiting
      // for the next long poll to come round.
      if (response.ok()) {
        const bool wanted = response.body.find("\"wanted\":true") != std::string::npos;
        ::pthread_mutex_lock(&mLock);
        mSnapshot.mirrorWanted = wanted;
        ::pthread_mutex_unlock(&mLock);
      }
    }

    // --- telemetry ---------------------------------------------------------
    //
    // On the cadence, OR immediately when the panel changed state. Reading the
    // dirty flag needs the lock, so it is read here rather than folded into the
    // condition above; the extra POST is at most one per sleep edge, which is
    // twice a night.
    bool telemetryDirty = false;
    {
      ::pthread_mutex_lock(&mLock);
      telemetryDirty = mTelDirty;
      ::pthread_mutex_unlock(&mLock);
    }
    if (telemetryDirty || now - lastReportMs >= static_cast<uint64_t>(kReportIntervalMs)) {
      lastReportMs = now;
      ::pthread_mutex_lock(&mLock);
      mTelDirty = false;
      const std::string screen = mTelScreen;
      const std::string focus = mTelFocus;
      const std::string wifi = mTelWifi;
      const std::string ip = mTelIp;
      const int restarts = mTelRestarts;
      const int battery = mTelBattery;
      const int batteryMv = mTelBatteryMv;
      const bool charging = mTelCharging;
      const bool flashed = mTelFlashed;
      const bool sleepOn = mTelSleepOn;
      const int sleepStartMin = mTelSleepStartMin;
      const int sleepEndMin = mTelSleepEndMin;
      const int sleepIdleSec = mTelSleepIdleSec;
      const bool sleepAsleep = mTelSleepAsleep;
      const bool sleepClockSynced = mTelSleepClockSynced;
      ::pthread_mutex_unlock(&mLock);

      Report report;
      report.screen = screen;
      report.focus = focus;
      report.wifi = wifi;
      report.ip = ip;
      report.uptimeMs = now - startedMs;
      report.freeKb = freeKb();
      report.supplicantRestarts = restarts;
      report.batteryPercent = battery;
      report.batteryMillivolts = batteryMv;
      report.charging = charging;
      report.flashed = flashed;
      report.sleepOn = sleepOn;
      report.sleepStartMin = sleepStartMin;
      report.sleepEndMin = sleepEndMin;
      report.sleepIdleSec = sleepIdleSec;
      report.sleepAsleep = sleepAsleep;
      report.sleepClockSynced = sleepClockSynced;
      report.upgradeSeqInstalled = installedUpgradeSeq();

      HttpClient::Response response;
      HttpClient::perform(mBaseUrl + "/api/os/report", "POST", "application/json",
                          reportBody(report), &response, 4000);
    }

    ::usleep(30000);  // 30 ms: fine enough to hit the 100 ms mirror cadence
  }
}

void HostLink::runUpgrade(int seq) {
  // A local, so the staging file's owner dies with the attempt: the destructor
  // unlinks a partial that nothing else got round to cleaning up.
  FirmwareUpdate update;
  const FirmwareUpdate::Verdict verdict =
      update.fetch(mBaseUrl + "/api/os/firmware", FirmwareUpdate::stagingDir(),
                   kFirmwareTimeoutMs, &HostLink::upgradeProgress, this);
  noteUpgradeResult(seq, static_cast<int>(verdict));
}

void HostLink::upgradeProgress(void* self, long received, long total) {
  static_cast<HostLink*>(self)->noteUpgradeProgress(received, total);
}

int HostLink::takeUpgradeRequest() {
  ::pthread_mutex_lock(&mLock);
  int seq = 0;
  if (mUpgradeArmedSeq != 0 && mUpgradeArmedSeq != mUpgradeStartedSeq) {
    seq = mUpgradeArmedSeq;
    mUpgradeStartedSeq = seq;
    mUpgrade.stage = UpgradeState::kDownloading;
    mUpgrade.seq = seq;
    mUpgrade.received = 0;
    mUpgrade.total = 0;
    mUpgrade.verdict = 0;
  }
  ::pthread_mutex_unlock(&mLock);
  return seq;
}

int HostLink::takeBleOpenRequest() {
  ::pthread_mutex_lock(&mLock);
  const int seq = mBleOpenPendingSeq;
  // Cleared, not compared against a "started" twin like the upgrade's: there is
  // no second phase to report progress for, so the pending id IS the whole
  // state. mBleOpenArmedSeq keeps the high-water mark, which is what makes the
  // document repeating this request on every poll a no-op.
  mBleOpenPendingSeq = 0;
  ::pthread_mutex_unlock(&mLock);
  return seq;
}

void HostLink::noteUpgradeProgress(long received, long total) {
  ::pthread_mutex_lock(&mLock);
  mUpgrade.received = received;
  mUpgrade.total = total;
  ::pthread_mutex_unlock(&mLock);
}

void HostLink::noteUpgradeResult(int seq, int verdict) {
  ::pthread_mutex_lock(&mLock);
  if (seq == mUpgrade.seq) {
    if (verdict == static_cast<int>(FirmwareUpdate::kOk)) {
      mUpgrade.stage = UpgradeState::kInstalling;
      mUpgradeInstallReady = true;
    } else {
      mUpgrade.stage = UpgradeState::kFailed;
      mUpgrade.verdict = verdict;
    }
  }
  ::pthread_mutex_unlock(&mLock);
}

int HostLink::readUpgradeSeq(const char* path) {
  FILE* f = ::fopen(path, "rb");
  if (f == 0) return 0;
  char buf[32];
  const size_t got = ::fread(buf, 1, sizeof(buf) - 1, f);
  ::fclose(f);
  // A record longer than the buffer is not a record we wrote. Refusing it whole
  // beats parsing its first 31 bytes, which is how "12 gigabytes of zeroes that
  // happen to start with a digit" becomes a valid id.
  if (got >= sizeof(buf) - 1) return 0;
  buf[got] = '\0';

  // THE ASYMMETRY IS THE WHOLE DESIGN. Reading a good record as 0 costs one
  // extra install. Reading junk as a large number costs the device: the guard
  // is "newer than what I installed", so a record of INT_MAX can never be
  // beaten and that unit is off the update path permanently.
  //
  // Hand-rolled rather than strtol, and the reason is testability, not taste.
  // `long` is 32 bits on the ARM this ships to, so strtol clamps an overflowing
  // value to LONG_MAX == 0x7fffffff — indistinguishable from a legal id, and a
  // `> 0x7fffffff` range test waves it straight through. That test lived here
  // and PASSED the self-check for one reason only: the self-check builds LP64
  // on the host, where `long` is wider and the same line behaves the opposite
  // way. A digit loop with an explicit ceiling checked on EVERY digit behaves
  // identically at both widths, which is what makes the host assertion below
  // evidence about the device rather than about the build machine.
  const char* p = buf;
  if (*p < '0' || *p > '9') return 0;  // not a number at all
  long long value = 0;
  for (; *p >= '0' && *p <= '9'; ++p) {
    value = value * 10 + (*p - '0');
    if (value > 2147483647LL) return 0;
  }
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
  if (*p != '\0') return 0;  // trailing junk: not ours, do not guess
  if (value <= 0) return 0;
  return static_cast<int>(value);
}

bool HostLink::writeUpgradeSeq(const char* path, int seq) {
  if (seq <= 0) return false;
  char buf[32];
  ::snprintf(buf, sizeof(buf), "%d\n", seq);
  // Compare-first and fsync'd: /data is jffs2, and this record is read exactly
  // once, on the far side of a reboot the vendor chain performs without asking.
  if (!ProvisionLog::writeFileIfChanged(path, buf)) return false;
  // Read it back through the guard's own parser. fwrite reporting success says
  // the bytes left this process; what matters is the value a LATER BOOT will
  // parse, and those are not the same claim.
  return readUpgradeSeq(path) == seq;
}

int HostLink::installedUpgradeSeq() const {
  return readUpgradeSeq(mUpgradeSeqPath.c_str());
}

void HostLink::setUpgradeSeqPath(const char* path) {
  if (path != 0) mUpgradeSeqPath = path;
}

bool HostLink::noteUpgradeInstalled(int seq) {
  return writeUpgradeSeq(mUpgradeSeqPath.c_str(), seq);
}

void HostLink::noteInstallFailed(int reason) {
  ::pthread_mutex_lock(&mLock);
  mUpgrade.stage = UpgradeState::kFailed;
  mUpgrade.verdict = kInstallVerdictBase + reason;
  // The install flag goes with it. A reason to stop is not a reason to leave a
  // loaded trigger behind for the next tick to pull.
  mUpgradeInstallReady = false;
  ::pthread_mutex_unlock(&mLock);
}

bool HostLink::takeUpgradeInstallReady() {
  ::pthread_mutex_lock(&mLock);
  const bool ready = mUpgradeInstallReady;
  mUpgradeInstallReady = false;
  ::pthread_mutex_unlock(&mLock);
  return ready;
}

HostLink::UpgradeState HostLink::upgradeState() const {
  ::pthread_mutex_lock(&mLock);
  const UpgradeState copy = mUpgrade;
  ::pthread_mutex_unlock(&mLock);
  return copy;
}

std::string HostLink::reportBody(const Report& report) {
  const std::string screen = jsonEscape(report.screen);
  const std::string focus = jsonEscape(report.focus);
  const std::string wifi = jsonEscape(report.wifi);
  const std::string ip = jsonEscape(report.ip);
  // Sized from the escaped strings rather than fixed, so this cannot truncate.
  // The literal skeleton is ~230 bytes and the sixteen numbers and booleans
  // below cannot exceed ~145 together, which 512 clears with room to spare — and
  // the next field added does not have to re-derive that, because the only
  // unbounded parts are already measured.
  //
  // A std::string rather than a std::vector<char> for the buffer: strings are
  // instantiated all over this firmware and a second container template is not,
  // and the .so has a size budget to live inside (hostcheck/link-audit.sh).
  // `&buffer[0]` addresses size() + 1 writable bytes (the terminator included),
  // so passing size() to snprintf stays in bounds.
  std::string buffer(screen.size() + focus.size() + wifi.size() + ip.size() + 512, '\0');
  ::snprintf(&buffer[0], buffer.size(),
             "{\"screen\":\"%s\",\"focus\":\"%s\",\"wifi\":\"%s\",\"ip\":\"%s\","
             "\"uptimeMs\":%llu,\"freeKb\":%d,\"supplicantRestarts\":%d,"
             // -1 until the first successful MCU reading; the console shows
             // nothing rather than a plausible-looking zero. The millivolts are
             // the quantity the shutdown protection actually runs on, and the
             // percentage is display only — so the console has to be able to
             // show both, or "is the percentage right?" has no answer short of
             // opening the case (platform/BatteryPolicy.h).
             "\"batteryPercent\":%d,\"batteryMillivolts\":%d,\"charging\":%s,"
             // Only the device knows this, and the console needs it to say
             // what a power cycle will bring back. Getting it wrong is the
             // dangerous direction: promising the official firmware to
             // someone whose flash holds ZOS.
             "\"flashed\":%s,"
             // Which state document this build can read. Without it the service
             // assumes 0 and keeps sending the pre-ADR-0008 encoding, which is
             // exactly what a device that never said so needs — and exactly what
             // makes the karaoke timing invisible on one that can read it.
             "\"proto\":%d,"
             // 夜间休眠. `asleep` is what lets the console say 休眠中 rather
             // than show a black rectangle; the config is the EFFECTIVE one,
             // which is the only truth a settings form should render.
             "\"sleep\":{\"on\":%s,\"startMin\":%d,\"endMin\":%d,\"idleSec\":%d,"
             "\"asleep\":%s,\"clockSynced\":%s},"
             // What this device has already installed, so the console can
             // retire a standing request on evidence rather than on a reboot
             // it inferred from an uptime that happened to go backwards.
             "\"upgradeSeqInstalled\":%d}",
             screen.c_str(), focus.c_str(), wifi.c_str(), ip.c_str(),
             static_cast<unsigned long long>(report.uptimeMs), report.freeKb,
             report.supplicantRestarts, report.batteryPercent, report.batteryMillivolts,
             report.charging ? "true" : "false", report.flashed ? "true" : "false",
             StateDoc::kProtocol,
             report.sleepOn ? "true" : "false", report.sleepStartMin, report.sleepEndMin,
             report.sleepIdleSec, report.sleepAsleep ? "true" : "false",
             report.sleepClockSynced ? "true" : "false", report.upgradeSeqInstalled);
  // Rebuilt from the C string so the result ends at the terminator rather than
  // carrying the buffer's slack as trailing NULs.
  return std::string(buffer.c_str());
}

void HostLink::adoptDocument(const StateDoc& doc, uint64_t stampMonoMs) {
  ::pthread_mutex_lock(&mLock);
  mSnapshot.online = true;
  mSnapshot.seq = doc.seq();
  mSnapshot.pinned = doc.pinned();
  mSnapshot.mirrorWanted = doc.mirror();
  mSnapshot.focus = doc.focus();
  mSnapshot.items = doc.items();
  // Copied here with everything else. A document with no VIBE block means the
  // host has nobody signed in, and keeping the previous agents alive through it
  // would leave quota numbers on the panel that the service has stopped
  // standing behind.
  mSnapshot.vibe = doc.vibe();
  mSnapshot.upgradeSeq = doc.upgradeSeq();
  // The console asking for an install ARMS A DOWNLOAD; nothing is installed
  // until a whole image is on the device. The gate is here rather than in the
  // UI tick because the download belongs to the worker, and because this
  // function is the one entry point a host self-check can drive — the pull
  // thread's body needs a socket, and a check that re-implemented the gate
  // would agree with a runPull that dropped the field.
  //
  // TWO GUARDS, and they are asking different questions. `!= mUpgradeArmedSeq`
  // is in memory and means "this is not the request I am already working on" —
  // the document repeats the same id on every poll, and without it each poll
  // would start another download. It is inequality because a CHANGE of id is
  // what arms one.
  // ...and not one we have already installed. That record is on disk, because
  // a successful install REBOOTS: an in-memory guard is guaranteed to be gone
  // exactly when it is needed, and the device reinstalls the same image on
  // every boot until someone withdraws the request. Measured on hardware —
  // the loop is real and it takes the panel down with it.
  if (doc.upgradeSeq() > 0 && doc.upgradeSeq() != mUpgradeArmedSeq &&
      doc.upgradeSeq() > installedUpgradeSeq()) {
    mUpgradeArmedSeq = doc.upgradeSeq();
    mUpgrade.stage = UpgradeState::kPending;
    mUpgrade.seq = mUpgradeArmedSeq;
    mUpgrade.received = 0;
    mUpgrade.total = 0;
    mUpgrade.verdict = 0;
  }
  // 蓝牙配网. Armed here rather than in the UI tick for the same reason the
  // install is: this function is the one entry point a host self-check can
  // drive, and a gate re-implemented anywhere else would agree with a runPull
  // that dropped the field.
  //
  // GREATER THAN, not different from. There is no /data record behind this one
  // (nothing reboots), so the in-memory high-water mark is the only guard there
  // is — and it has to be one the standing document cannot beat, because the
  // console keeps publishing the same id on every poll for as long as it
  // remembers it. `!=` would be enough for that alone, but `>` also makes a
  // service that restarted its counter unable to re-open the window with an id
  // this boot already honoured.
  if (doc.bleOpenSeq() > 0 && doc.bleOpenSeq() > mBleOpenArmedSeq) {
    mBleOpenArmedSeq = doc.bleOpenSeq();
    mBleOpenPendingSeq = doc.bleOpenSeq();
  }
  mSnapshot.consecutiveFailures = 0;
  // The one stamp that says the console link is ALIVE, set here because this
  // function runs on exactly one event: a document that parsed. See the field's
  // comment for why it is not the now-playing stamp a few lines down.
  mSnapshot.lastPullMonoMs = stampMonoMs;
  // Every now-playing field, unconditionally — including the ones the document
  // left out. A document with no `np` block means nothing is playing, and
  // keeping the previous song's title alive through it would put a track on the
  // panel that the service has already stopped describing.
  mSnapshot.nowPlaying = doc.hasNowPlaying();
  mSnapshot.playing = doc.playing();
  mSnapshot.track = doc.track();
  mSnapshot.artist = doc.artist();
  mSnapshot.lyric = doc.lyric();
  mSnapshot.positionMs = doc.positionMs();
  mSnapshot.durationMs = doc.durationMs();
  mSnapshot.lyricStartMs = doc.lyricStartMs();
  mSnapshot.lyricEndMs = doc.lyricEndMs();
  mSnapshot.lyricUntilMs = doc.lyricUntilMs();
  mSnapshot.lyricCells = doc.lyricCells();
  mSnapshot.stampMonoMs = stampMonoMs;
  // The theme, copied with everything else. StateDoc has already resolved an
  // absent or unrecognised value to the default, so there is nothing to guard
  // here — and guarding it here instead would put the fallback in two places.
  mSnapshot.lyricMode = doc.lyricMode();
  mSnapshot.lyricSkin = doc.lyricSkin();
  mSnapshot.accentRgb = doc.accentRgb();
  mSnapshot.hasAccent = doc.hasAccent();
  // Console -> device. Copied here with everything else for the same reason the
  // now-playing fields are: a snapshot assembled in two places is a snapshot
  // that will one day disagree with itself.
  mSnapshot.settings = doc.settings();
  mSnapshot.sleep = doc.sleep();
  mSnapshot.inputs = doc.inputs();
  ::pthread_mutex_unlock(&mLock);
}

HostLink::Snapshot HostLink::snapshot() const {
  ::pthread_mutex_lock(&mLock);
  const Snapshot copy = mSnapshot;
  ::pthread_mutex_unlock(&mLock);
  return copy;
}

void HostLink::wantChannel(const std::string& appName, const std::string& rev, bool force) {
  ::pthread_mutex_lock(&mLock);
  if (force || mWantApp != appName || mWantRev != rev) {
    mWantApp = appName;
    mWantRev = rev;
    mWantSeq += 1;
    // Cleared on every new request, so the ring leaves 加载失败 as soon as the
    // user asks for something else rather than sitting on the last failure.
    mFetchFailed = false;
  }
  ::pthread_mutex_unlock(&mLock);
}

void HostLink::selectChannel(const std::string& appName, const std::string& rev) {
  wantChannel(appName, rev, false);
}

void HostLink::refreshChannel(const std::string& appName, const std::string& rev) {
  wantChannel(appName, rev, true);
}

bool HostLink::takeChannelFrames(FrameBundle* out, std::string* appName, std::string* rev) {
  ::pthread_mutex_lock(&mLock);
  const bool ready = mPendingReady;
  if (ready) {
    out->swap(mPending);
    mPending = FrameBundle();
    mPendingReady = false;
    *appName = mHaveApp;
    *rev = mPendingRev;
  }
  ::pthread_mutex_unlock(&mLock);
  return ready;
}

bool HostLink::channelLoading() const {
  ::pthread_mutex_lock(&mLock);
  const bool loading = !mWantApp.empty() && mWantSeq != mHaveSeq && !mFetchFailed;
  ::pthread_mutex_unlock(&mLock);
  return loading;
}

bool HostLink::channelFailed() const {
  ::pthread_mutex_lock(&mLock);
  const bool failed = mFetchFailed;
  ::pthread_mutex_unlock(&mLock);
  return failed;
}

int HostLink::channelRequestCount() const {
  ::pthread_mutex_lock(&mLock);
  const int count = mWantSeq;
  ::pthread_mutex_unlock(&mLock);
  return count;
}

void HostLink::publishMirror(const uint8_t* rgb, int bytes) {
  if (rgb == 0 || bytes <= 0) return;
  ::pthread_mutex_lock(&mLock);
  // Dropped outright when nobody is looking: the copy is cheap but it is not
  // free, and it would run 25 times a second forever.
  if (mSnapshot.mirrorWanted) {
    mMirrorFrame.assign(rgb, rgb + bytes);
    mMirrorDirty = true;
  }
  ::pthread_mutex_unlock(&mLock);
}

void HostLink::sendMusicAction(const char* action) {
  if (action == 0) return;
  ::pthread_mutex_lock(&mLock);
  // Four is a knob turned faster than the network can keep up with. Dropping
  // the oldest rather than the newest is what makes a fast spin land on the
  // track the user stopped at instead of somewhere behind it.
  if (mActions.size() >= 4) mActions.erase(mActions.begin());
  mActions.push_back(std::string(action));
  ::pthread_mutex_unlock(&mLock);
}

void HostLink::setTelemetry(const std::string& screen, const std::string& focus,
                            const std::string& wifi, const std::string& ip,
                            int supplicantRestarts, int batteryPercent, int batteryMillivolts,
                            bool charging, bool flashed, bool sleepOn, int sleepStartMin,
                            int sleepEndMin, int sleepIdleSec, bool sleepAsleep,
                            bool sleepClockSynced) {
  ::pthread_mutex_lock(&mLock);
  mTelScreen = screen;
  mTelFocus = focus;
  mTelWifi = wifi;
  mTelIp = ip;
  mTelRestarts = supplicantRestarts;
  mTelBattery = batteryPercent;
  mTelBatteryMv = batteryMillivolts;
  mTelCharging = charging;
  mTelFlashed = flashed;
  mTelSleepOn = sleepOn;
  mTelSleepStartMin = sleepStartMin;
  mTelSleepEndMin = sleepEndMin;
  mTelSleepIdleSec = sleepIdleSec;
  // The panel going dark or coming back is the only telemetry field a console
  // ACTS on rather than displays, so it does not wait for the 10 s cadence: the
  // console clears its canvas and says 已息屏 off this flag, and a stale `true`
  // means a lit panel painted as a blank one for up to ten seconds after the
  // user's own press woke it. The user then presses again — and that press is
  // not swallowed, so it changes the channel. The mirror alone cannot fix it:
  // the console must never infer sleep from the pixels.
  if (sleepAsleep != mTelSleepAsleep) mTelDirty = true;
  mTelSleepAsleep = sleepAsleep;
  mTelSleepClockSynced = sleepClockSynced;
  ::pthread_mutex_unlock(&mLock);
}

}  // namespace tcos
