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

    Snapshot() : online(false), seq(0), pinned(false), mirrorWanted(false),
                 consecutiveFailures(0), nowPlaying(false), playing(false),
                 positionMs(0), durationMs(0), stampMonoMs(0) {}
  };

  HostLink();
  ~HostLink();

  /** `baseUrl` is like "http://192.168.8.185:43820". Safe to call once. */
  void start(const std::string& baseUrl);
  void stop();

  const std::string& baseUrl() const { return mBaseUrl; }

  Snapshot snapshot() const;

  /**
   * Ask for a channel's frames. Idempotent for the same app: asking again while
   * that app's frames are already loaded does nothing, so a screen can call it
   * every tick without thinking about it.
   */
  void selectChannel(const std::string& appName);

  /**
   * Moves freshly downloaded frames into `out`, if any arrived since the last
   * call. Returns false when there is nothing new. `out` is left untouched on
   * false, so a playing channel keeps playing.
   */
  bool takeChannelFrames(FrameBundle* out, std::string* appName);

  /** True while a fetch for the selected channel is in flight. */
  bool channelLoading() const;
  /** True when the last fetch for the selected channel failed. */
  bool channelFailed() const;

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
                    int supplicantRestarts);

  // 10 fps rather than the panel's 25: the console preview is a monitor, not a
  // video feed, and each frame is a separate HTTP exchange on a device whose
  // radio is also carrying the long poll.
  static const int kMirrorIntervalMs = 100;
  static const int kReportIntervalMs = 10000;
  // The long poll answers in 8 s; the read budget has to clear that with room
  // for the round trip or every successful hold looks like a timeout.
  static const int kPullTimeoutMs = 13000;
  static const int kFrameTimeoutMs = 20000;

 private:
  HostLink(const HostLink&);
  HostLink& operator=(const HostLink&);

  static void* pullMain(void* self);
  static void* workerMain(void* self);
  void runPull();
  void runWorker();

  std::string mBaseUrl;

  mutable pthread_mutex_t mLock;
  pthread_t mPullThread;
  pthread_t mWorkerThread;
  bool mRunning;
  bool mThreadsStarted;

  Snapshot mSnapshot;

  // Channel frames. mWantApp is what the UI asked for; mHaveApp is what the
  // worker last delivered. They differ exactly while a fetch is pending.
  std::string mWantApp;
  std::string mHaveApp;
  std::string mFetchingApp;
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
};

}  // namespace tcos

#endif  // NET_HOSTLINK_H_
