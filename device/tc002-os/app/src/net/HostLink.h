#ifndef NET_HOSTLINK_H_
#define NET_HOSTLINK_H_

#include <pthread.h>
#include <stdint.h>

#include <string>
#include <vector>

#include "net/FrameBundle.h"
#include "net/StateDoc.h"

namespace tcos {

/**
 * The device's half of the console link.
 *
 * The direction is inverted from every other transport in this project: the
 * device pulls. Replacing the official app deletes its `POST /api/custom`
 * receiver, and — more usefully — a service that never has to open a socket to
 * the device is immune to the failure that broke the notify webhook, where a
 * launchd process on the host had no macOS local-network permission and could
 * not reach the LAN at all.
 *
 * Two threads, because one cannot do both jobs. The pull endpoint holds a
 * connection open for up to 8 s waiting for the console to change something;
 * a single thread doing that could not also ship mirror frames, and a mirror
 * that only updates every 8 s is not a mirror.
 *
 * The UI tick never blocks on either. It reads a snapshot under a short lock
 * and hands over frames by swapping vectors, so the cost on the render path is
 * a pointer swap rather than a copy of ~900 KB of channel frames.
 */
class HostLink {
 public:
  struct Snapshot {
    bool online;          // a pull has succeeded recently
    int seq;
    bool pinned;          // the console is driving; the ring is locked
    bool mirrorWanted;
    std::string focus;
    std::vector<StateDoc::Item> items;
    // 「VIBE」. A reading, not a setting: it has an external source that can
    // fail, and the service says so per agent with `stale` rather than by
    // dropping the row. Empty means nobody is signed in on the host — or that
    // the service predates the VIBE block, which the panel words the same way.
    std::vector<StateDoc::VibeAgent> vibe;
    /**
     * Console-initiated install request; 0 when never asked.
     *
     * Kept as the document's own field. What the firmware ACTS on is
     * upgradeState(), which this class derives from it — see adoptDocument.
     */
    int upgradeSeq;
    int consecutiveFailures;
    /**
     * Raw monotonic ms of the last document that arrived; 0 when none ever has.
     *
     * A SECOND FIELD rather than a read of `stampMonoMs` below, which today
     * holds the same number. That one is documented as the now-playing stamp and
     * belongs to the music screen; this one is the input to
     * ConsoleDiscovery's "the device is already lost" gate, which decides
     * whether a stranger's broadcast may rewrite /data/zos-host. Sharing the
     * field would mean a later change scoped to now-playing — "only stamp it
     * when the document carries an `np` block" is the obvious one — silently
     * turns a device that is perfectly online into one that adopts hints.
     *
     * `online` cannot serve either: it goes false after three consecutive
     * failures, which is ~30 s of backoff, and it says nothing about HOW LONG
     * the device has been out of touch.
     */
    uint64_t lastPullMonoMs;

    // Now playing, resolved to text by the service. `stampMonoMs` is the raw
    // monotonic clock when the document arrived, not the UI's zero-based one:
    // the pull thread has no idea when the app started, so the conversion
    // belongs to whoever owns that origin.
    bool nowPlaying;
    bool playing;
    std::string track;
    std::string artist;
    std::string lyric;
    int positionMs;
    int durationMs;
    uint64_t stampMonoMs;
    // The current lyric line's window, or -1/-1 when the service does not send
    // one. Every display mode animates within the line, so this travels with
    // the lyric rather than being derived from pos/dur.
    //
    // `lyricEndMs` is when the line stopped being SUNG and `lyricUntilMs` is
    // when the next one takes over; they are the same number on a line followed
    // immediately by another and ten or more seconds apart on the last line of a
    // verse. `lyricUntilMs` is -1 when the line is not held — see
    // StateDoc::lyricUntilMs, where the absence is the message.
    int lyricStartMs;
    int lyricEndMs;
    int lyricUntilMs;
    // One entry per glyph of `lyric`, when the source really carries word
    // timings. Empty for the ~80% of tracks that do not, which is the shape the
    // panel has always rendered.
    LyricCellTable lyricCells;

    // Console -> device. See StateDoc for why each carries a sequence, and why
    // the settings block carries three of them rather than one.
    SettingsRequest settings;
    SleepRequest sleep;
    std::vector<StateDoc::Input> inputs;

    // The console's 主题设置. A setting, not a reading: it has one writer and
    // no source that can die, so unlike now-playing it never expires and is
    // never gated on the link being live. Defaults match the service's, so the
    // panel is already right before the first document lands.
    int lyricMode;
    int lyricSkin;
    uint32_t accentRgb;
    bool hasAccent;

    // upgradeSeq is initialised HERE and not only where it is parsed: an
    // uninitialised int on the one field that ends in an erase of mtd3 is a
    // firmware that can decide to reinstall itself out of stack garbage before
    // the first document has even arrived.
    Snapshot() : online(false), seq(0), pinned(false), mirrorWanted(false),
                 upgradeSeq(0),
                 consecutiveFailures(0), lastPullMonoMs(0),
                 nowPlaying(false), playing(false),
                 positionMs(0), durationMs(0), stampMonoMs(0),
                 lyricStartMs(-1), lyricEndMs(-1), lyricUntilMs(-1),
                 lyricMode(StateDoc::kDefaultMode), lyricSkin(StateDoc::kDefaultSkin),
                 accentRgb(0), hasAccent(false) {}
  };

  HostLink();
  ~HostLink();

  /** `baseUrl` is like "http://192.168.8.185:43820". Safe to call once. */
  void start(const std::string& baseUrl);
  void stop();

  const std::string& baseUrl() const { return mBaseUrl; }

  Snapshot snapshot() const;

  /**
   * Copies a parsed document into the snapshot. `stampMonoMs` is the raw
   * monotonic clock at which it arrived.
   *
   * Public, and separate from runPull, because the pull thread's body cannot be
   * reached without a socket and a self-check that re-implemented the copy would
   * have agreed with a runPull that silently dropped a field — which is exactly
   * how the whole now-playing block could reach StateDoc and never reach the
   * music screen.
   */
  void adoptDocument(const StateDoc& doc, uint64_t stampMonoMs);

  /**
   * Ask for a channel's frames at a given content revision.
   *
   * Idempotent for the same (app, rev) pair, so a screen can call it every tick
   * without thinking about it — but NOT for the same app alone, which is the
   * distinction this whole class was missing. Keyed on the name only, a
   * re-select of the channel already loaded was a permanent no-op: an edit
   * leaves the name exactly where it was, so nothing downstream ever ran and
   * turning the knob away and back was the only way to reach new pixels.
   *
   * An empty `rev` is what an older service produces. It compares equal to
   * itself, so such a device keeps the behaviour it has always had: one fetch
   * per channel change and no content-driven refresh.
   */
  void selectChannel(const std::string& appName, const std::string& rev);

  /**
   * Fetch the channel again even though nothing about it changed.
   *
   * For the two cases a revision cannot express: a bundle that has outlived its
   * ttl (a clock face renders a time, and the time moves without anyone editing
   * anything), and walking back into the ring after minutes away. Both are
   * rate-limited by the caller — see ChannelRingScreen::takeRefreshDue — because
   * this bypasses every gate that would otherwise stop a loop.
   */
  void refreshChannel(const std::string& appName, const std::string& rev);

  /**
   * Moves freshly downloaded frames into `out`, if any arrived since the last
   * call. Returns false when there is nothing new. `out` is left untouched on
   * false, so a playing channel keeps playing.
   *
   * `rev` receives the revision the SERVICE said it served (its `X-Os-Rev`
   * header), which is not always the one the document advertised: a save
   * landing between reading the menu and fetching the frames would otherwise
   * make the device believe its brand-new bundle is already stale.
   */
  bool takeChannelFrames(FrameBundle* out, std::string* appName, std::string* rev);

  /** True while a fetch for the selected channel is outstanding. */
  bool channelLoading() const;
  /** True when the last fetch for the selected channel failed. */
  bool channelFailed() const;

  /**
   * How many distinct frame requests have been raised since construction.
   *
   * Exposed because it is the only window onto the gate that decides whether an
   * ask reaches the network at all, and that decision having no observable is
   * precisely how it could be a permanent no-op for the entire life of this
   * class without a single test noticing. A self-check can now state the two
   * halves that matter: a re-ask for content we already hold must NOT count,
   * and a re-ask for the same channel at a new revision must.
   */
  int channelRequestCount() const;

  // -------------------------------------------------------------------------
  // Firmware install, requested by the console.
  //
  // The device DOWNLOADS the image before anything is installed. Until this
  // existed the only way an image reached the staging directory was a human
  // running `adb push`, which made the supported update path depend on a cable
  // and a laptop; everything else the panel shows already arrives over this
  // link, and now so does the firmware.
  //
  // The whole flow: a rising `upgrade` sequence in the pull document arms a
  // request (adoptDocument), the worker thread takes it (takeUpgradeRequest)
  // and streams the image to FirmwareUpdate::stagingDir() (tmpfs — see that
  // header for why it is not the UDISK partition it used to be),
  // reporting bytes as they land, and finally records a verdict
  // (noteUpgradeResult). ONLY a kOk verdict raises the install flag, and only
  // the UI thread takes it — the vendor updater is a thread that tears services
  // down, and the one place in this firmware that has ever called it is the UI
  // tick.

  struct UpgradeState {
    enum Stage {
      kIdle,         // nobody has asked
      kPending,      // asked, the worker has not picked it up yet
      kDownloading,  // streaming to the staging file
      kInstalling,   // a whole image is staged; the vendor chain is next
      kFailed,       // nothing was staged, and nothing will be installed
    };

    Stage stage;
    int seq;        // the console request this is about
    long received;  // bytes written so far
    long total;     // bytes the service declared, or 0 before the headers land
    // FirmwareUpdate::Verdict for a download that failed, or
    // kInstallVerdictBase + InstallFailure for one that got as far as the
    // vendor chain. Meaningful when stage == kFailed. The two spaces are kept
    // apart because "the download was truncated" and "the updater refused the
    // image" are different problems with different fixes, and the only record
    // of which one happened is this number in /data/zos-provision.log.
    int verdict;

    UpgradeState() : stage(kIdle), seq(0), received(0), total(0), verdict(0) {}
  };

  /**
   * Why an install that reached the vendor chain did not happen.
   *
   * EVERY ONE OF THESE USED TO BE A BARE `return`, and every one of them left
   * the panel reading 安装中 for as long as the device stayed up — the state
   * machine had no way out of kInstalling except a reboot. A firmware update
   * that fails silently and looks identical to one still in progress is worse
   * than one that fails loudly: nobody power-cycles a device that says it is
   * working.
   */
  enum InstallFailure {
    kInstallNoRecord = 1,  // /data would not take the request id; see below
    kInstallNoMonitor,     // UpgradeMonitor::getInstance() returned nothing
    kInstallNoImage,       // no candidate directory held one the updater wanted
    kInstallDeclined,      // startUpgrade() said no
    kInstallTimedOut,      // the chain neither rebooted nor came back
  };
  /** Keeps InstallFailure codes out of FirmwareUpdate::Verdict's range (0..8). */
  static const int kInstallVerdictBase = 100;

  /** Cheap enough to read on every UI tick; the panel draws a progress bar. */
  UpgradeState upgradeState() const;

  /**
   * The worker's gate: the request to download now, or 0.
   *
   * ONCE PER SEQUENCE. The document repeats `upgrade <n>` for as long as the
   * console remembers it, so a gate keyed on anything but the sequence's change
   * would re-download — and re-install — on every poll for the life of the
   * service. Public, like adoptDocument and for the same reason: the worker
   * thread's body cannot be reached without a socket, and a self-check that
   * re-implemented this gate would agree with a runWorker that got it wrong.
   */
  int takeUpgradeRequest();

  /** Called from the download as bytes land. */
  void noteUpgradeProgress(long received, long total);

  /**
   * Records how the attempt for `seq` ended. `verdict` is a
   * FirmwareUpdate::Verdict; only 0 (kOk) arms the install.
   *
   * A result for a sequence the console has already superseded is dropped: the
   * user pressing the button again while a download was running means they want
   * the NEW image, and installing the old one because it happened to finish
   * first is the wrong answer to that.
   */
  void noteUpgradeResult(int seq, int verdict);

  /**
   * True exactly once, after a COMPLETE image has been staged. The UI thread's
   * permission to call the vendor updater.
   */
  bool takeUpgradeInstallReady();

  /**
   * The request id this device has already handed to the updater, from `/data`.
   *
   * ON DISK, because the install ENDS IN A REBOOT. An in-memory guard is
   * cleared by the very event it exists to survive: the device comes back with
   * the counter at 0, the console is still publishing the same `upgrade <n>`,
   * the request reads as new, and the same image installs again — measured, and
   * it takes the panel with it, since the vendor chain reboots before the app
   * draws a frame. `/data` is mtd6; writing ZOS is mtd3, so this record outlives
   * the thing it is guarding against.
   *
   * 0 when nothing has been installed, which is also what an unreadable or
   * garbage file reports — the failure mode of "guard missing" is one extra
   * install, and of "guard stuck on" is a device that can never be updated.
   *
   * Compared with `>`, not `!=`: the ids are seconds-since-epoch, so "newer
   * than what I installed" is the actual question, and it is the one that can
   * be answered before the fact — a device can be seeded with the id it is
   * about to take, which is how a build that predates this record is upgraded
   * to one that keeps it without looping on the way.
   */
  int installedUpgradeSeq() const;

  /**
   * Records `seq` as installed, and says whether the record is really there.
   *
   * Called BEFORE the updater is knocked, never after: there is no after. The
   * return value is the whole point — writing this record is a PRECONDITION of
   * knocking, not a courtesy alongside it. If /data will not take it (full,
   * remounted read-only, a jffs2 error) and we knock anyway, the install
   * succeeds, the device reboots, the record is absent, the console's request
   * is still standing, and it installs again on every boot forever. Fail
   * closed: no record, no knock.
   *
   * Verified by READING IT BACK through the same strict parser the guard uses,
   * not by trusting fwrite's return: the value that matters is the one a later
   * boot will actually parse, and a write that lands as something the parser
   * rejects is a write that did not happen.
   *
   * A failed install therefore also consumes the request, which is deliberate —
   * the console allocates a strictly greater id per press, so retrying is a
   * press, while the alternative is a device that retries a broken image
   * forever without being asked.
   */
  bool noteUpgradeInstalled(int seq);

  /** Moves the panel out of 安装中 and says why. */
  void noteInstallFailed(int reason);

  /**
   * The file halves, path-injected so the host check drives the real parser and
   * the real writer against a scratch file rather than /data.
   *
   * readUpgradeSeq is STRICT, and it has to be, because its two failure modes
   * are not symmetric. Reading a valid record as 0 costs one extra install.
   * Reading junk as a huge number costs the device: the guard is "newer than
   * what I installed", so a record of INT_MAX can never be beaten and that unit
   * is off the update path for good, with no way back that does not involve
   * opening it. So: errno is checked (on this ARM `long` IS 32 bits, and
   * strtol clamps an overflowing value to LONG_MAX == 0x7fffffff, which a naive
   * range test waves straight through), the end pointer must land on the end of
   * the number, and a file too long to be one we wrote is refused outright.
   */
  static int readUpgradeSeq(const char* path);
  static bool writeUpgradeSeq(const char* path, int seq);

  /** Where the record lives. Overridable ONLY so the host check can drive the
   *  real guard end to end against a scratch file; the device never calls it. */
  void setUpgradeSeqPath(const char* path);

  // -------------------------------------------------------------------------
  // 蓝牙配网, requested by the console.
  //
  // Same shape as the install above and a fraction of its weight: a rising
  // `bleopen` sequence in the pull document arms a request (adoptDocument) and
  // the UI thread takes it (takeBleOpenRequest) to open the advertising window.
  // The UI thread, not the worker, because what it runs is a screen push and a
  // radio flag that only osLogic owns — nothing is downloaded and nothing is
  // written to flash.
  //
  // NO /data RECORD, unlike the install. That one needs one because it ENDS IN
  // A REBOOT, which wipes the in-memory guard exactly when it is needed; this
  // one leaves the device up, so the member below survives for as long as the
  // request can still be standing. And a request honoured twice costs five more
  // minutes of advertising, not a reflash.

  /**
   * The UI thread's gate: the sequence to open the window for, or 0.
   *
   * ONCE PER RISING SEQUENCE, which is the whole reason it is a gate and not a
   * field read. The console's request sits in every document from the moment it
   * is made, so a UI tick that acted on the value would re-open the window and
   * re-push the provisioning screen on every poll — a device the user could
   * never navigate away from until the console forgot.
   */
  int takeBleOpenRequest();

  /**
   * Hands the finished frame to the mirror uploader. Cheap and non-blocking:
   * it copies 2496 bytes under a lock the worker holds only to take them.
   * Ignored entirely when the console is not watching.
   */
  void publishMirror(const uint8_t* rgb, int bytes);

  /**
   * Queues a transport command for the music screen: "play", "pause", "next"
   * or "previous". Posted to the device-facing music endpoint, which is the
   * same one the lyrics-player firmware uses and which turns the press into a
   * Connect command host-side — the device has no audio of its own to pause.
   */
  void sendMusicAction(const char* action);

  /**
   * What the device reports about itself; sent on the worker's own cadence, or
   * at once when `sleepAsleep` changed.
   *
   * The 夜间息屏 block is the console's ONLY honest source for two things it
   * cannot otherwise know. `sleepAsleep` is how it says 已息屏 instead of
   * painting a black rectangle — black pixels are indistinguishable from a dead
   * clock, which is the rule describeMirror already encodes for the offline
   * case, so the console must never infer sleep from the frame. And the four
   * config fields are the EFFECTIVE values, which differ from what the console
   * asked for whenever the knob moved them.
   *
   * The presence of the block is its OWN capability signal, and stays one even
   * now that `proto` exists beside it: it went out on a build that sent no
   * `proto` at all, so a service reading it off the version number would think
   * every such device lacked 夜间息屏.
   */
  void setTelemetry(const std::string& screen, const std::string& focus,
                    const std::string& wifi, const std::string& ip,
                    int supplicantRestarts, int batteryPercent, bool charging,
                    bool flashed, bool sleepOn, int sleepStartMin, int sleepEndMin,
                    int sleepIdleSec, bool sleepAsleep, bool sleepClockSynced);

  /** Everything POST /api/os/report carries, as one value. */
  struct Report {
    std::string screen;
    std::string focus;
    std::string wifi;
    std::string ip;
    uint64_t uptimeMs;
    int freeKb;
    int supplicantRestarts;
    int batteryPercent;
    bool charging;
    bool flashed;
    bool sleepOn;
    int sleepStartMin;
    int sleepEndMin;
    int sleepIdleSec;
    bool sleepAsleep;
    bool sleepClockSynced;
    /**
     * The request id this device has on /data — what it has already installed.
     *
     * The console needs this to retire a standing request, and it needs it
     * EXPLICITLY. Inferring it from an uptime that went backwards is a guess
     * that is wrong in a real case: if the last report before the reboot
     * happened early in that boot, the first report after it can carry a
     * LARGER uptime and the reboot is invisible. This number is the device
     * answering the actual question instead.
     */
    int upgradeSeqInstalled;

    Report()
        : uptimeMs(0), freeKb(0), supplicantRestarts(0), batteryPercent(-1),
          charging(false), flashed(false), sleepOn(false), sleepStartMin(0),
          sleepEndMin(0), sleepIdleSec(0), sleepAsleep(false),
          sleepClockSynced(false), upgradeSeqInstalled(0) {}
  };

  /**
   * The JSON body of that report, INCLUDING `proto`.
   *
   * Static and public because it used to be a snprintf into a fixed char[] in
   * the middle of runWorker — a thread body no host check can reach — and
   * snprintf TRUNCATES SILENTLY. A truncated body is invalid JSON, which the
   * service's readJson answers with a 400, which does not degrade telemetry but
   * kills it outright: no battery, no 已息屏, no `proto`, so the device silently
   * drops back to the legacy lyric encoding. The buffer had already been grown
   * from 512 to 1024 once for the sleep block; rather than audit that headroom
   * again for every new field, the body is now sized from its own inputs and
   * cannot be truncated at all.
   */
  static std::string reportBody(const Report& report);

  // 10 fps rather than the panel's 25: the console preview is a monitor, not a
  // video feed, and each frame is a separate HTTP exchange on a device whose
  // radio is also carrying the long poll.
  static const int kMirrorIntervalMs = 100;
  static const int kReportIntervalMs = 10000;
  // The long poll answers in 8 s; the read budget has to clear that with room
  // for the round trip or every successful hold looks like a timeout.
  static const int kPullTimeoutMs = 13000;
  static const int kFrameTimeoutMs = 20000;
  // Per READ, like every other budget here, so a slow transfer that is still
  // making progress is not cut off part way. The image is up to 8 MiB and the
  // whole download is one request; 20 s of silence on a LAN transfer is a dead
  // peer, not a slow one.
  static const int kFirmwareTimeoutMs = 20000;
  // How long a failed fetch of the same request waits before trying again.
  // Without it the worker re-attempts on its next 30 ms pass, which against a
  // service that refuses the connection outright — the shape of a laptop that
  // went to sleep — is a tight loop for as long as the device is on that
  // channel. A user-driven change still goes immediately: the wait is keyed on
  // the request that failed, not on the clock alone.
  static const int kFetchRetryMs = 3000;

 private:
  HostLink(const HostLink&);
  HostLink& operator=(const HostLink&);

  static void* pullMain(void* self);
  static void* workerMain(void* self);
  void runPull();
  void runWorker();
  /** Blocks the worker for the whole download. See the call site for why. */
  void runUpgrade(int seq);
  static void upgradeProgress(void* self, long received, long total);
  void wantChannel(const std::string& appName, const std::string& rev, bool force);

  std::string mBaseUrl;

  mutable pthread_mutex_t mLock;
  pthread_t mPullThread;
  pthread_t mWorkerThread;
  bool mRunning;
  bool mThreadsStarted;

  Snapshot mSnapshot;

  // Channel frames. mWantApp/mWantRev is what the UI asked for; mHaveApp is
  // what the worker last delivered.
  //
  // The GATE is the serial, not the app name. Every genuinely new request bumps
  // it, and the worker compares serials — so "the same channel, new content"
  // and "the same channel, stale render" are both askable, which keying on the
  // name alone made structurally impossible. Zero means "no request", so a
  // fetch in flight always carries a non-zero serial and clearing mFetchingSeq
  // to 0 is unambiguous.
  std::string mWantApp;
  std::string mWantRev;
  int mWantSeq;
  int mHaveSeq;
  int mFetchingSeq;
  std::string mHaveApp;
  std::string mPendingRev;
  bool mFetchFailed;
  FrameBundle mPending;
  bool mPendingReady;

  // At most a handful can pile up between worker passes; a spun knob that
  // outruns the network should skip tracks, not queue a minute of them.
  std::vector<std::string> mActions;

  // The install request. mUpgradeArmedSeq is what the console asked for,
  // mUpgradeStartedSeq is what the worker has already picked up; they differ
  // for exactly as long as one request is waiting to be served, which is what
  // makes "once per sequence" a comparison rather than a timer.
  UpgradeState mUpgrade;
  int mUpgradeArmedSeq;
  int mUpgradeStartedSeq;
  bool mUpgradeInstallReady;
  std::string mUpgradeSeqPath;

  // 蓝牙配网. mBleOpenArmedSeq is the highest request ever seen this boot —
  // never cleared, because it is what makes a repeated document a no-op —
  // and mBleOpenPendingSeq is the one the UI thread has not taken yet.
  int mBleOpenArmedSeq;
  int mBleOpenPendingSeq;

  std::vector<uint8_t> mMirrorFrame;
  bool mMirrorDirty;

  std::string mTelScreen;
  std::string mTelFocus;
  std::string mTelWifi;
  std::string mTelIp;
  int mTelRestarts;
  int mTelBattery;
  bool mTelCharging;
  bool mTelFlashed;
  bool mTelSleepOn;
  int mTelSleepStartMin;
  int mTelSleepEndMin;
  int mTelSleepIdleSec;
  bool mTelSleepAsleep;
  bool mTelSleepClockSynced;
  // Set when the panel's dark/lit state changed, so the report goes out on the
  // worker's next 30 ms pass instead of on its 10 s one. Only that field: the
  // rest of telemetry is a display, and a display can be ten seconds old.
  bool mTelDirty;
};

}  // namespace tcos

#endif  // NET_HOSTLINK_H_
