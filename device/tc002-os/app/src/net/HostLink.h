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
    int consecutiveFailures;

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
    int lyricStartMs;
    int lyricEndMs;

    // Console -> device. See StateDoc for why each carries a sequence.
    int settingsSeq;
    int requestedVolume;
    int requestedBrightness;
    std::vector<StateDoc::Input> inputs;

    // The console's 主题设置. A setting, not a reading: it has one writer and
    // no source that can die, so unlike now-playing it never expires and is
    // never gated on the link being live. Defaults match the service's, so the
    // panel is already right before the first document lands.
    int lyricMode;
    int lyricSkin;
    uint32_t accentRgb;
    bool hasAccent;

    Snapshot() : online(false), seq(0), pinned(false), mirrorWanted(false),
                 consecutiveFailures(0), nowPlaying(false), playing(false),
                 positionMs(0), durationMs(0), stampMonoMs(0),
                 lyricStartMs(-1), lyricEndMs(-1), settingsSeq(0),
                 requestedVolume(-1), requestedBrightness(-1),
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

  /** What the device reports about itself; sent on the worker's own cadence. */
  void setTelemetry(const std::string& screen, const std::string& focus,
                    const std::string& wifi, const std::string& ip,
                    int supplicantRestarts, int batteryPercent, bool charging,
                    bool flashed);

  // 10 fps rather than the panel's 25: the console preview is a monitor, not a
  // video feed, and each frame is a separate HTTP exchange on a device whose
  // radio is also carrying the long poll.
  static const int kMirrorIntervalMs = 100;
  static const int kReportIntervalMs = 10000;
  // The long poll answers in 8 s; the read budget has to clear that with room
  // for the round trip or every successful hold looks like a timeout.
  static const int kPullTimeoutMs = 13000;
  static const int kFrameTimeoutMs = 20000;
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
};

}  // namespace tcos

#endif  // NET_HOSTLINK_H_
