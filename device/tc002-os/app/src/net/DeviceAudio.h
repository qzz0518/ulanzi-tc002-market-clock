#ifndef NET_DEVICEAUDIO_H_
#define NET_DEVICEAUDIO_H_

#include <pthread.h>
#include <stdint.h>
#include <stdio.h>

#include <string>
#include <vector>

#include "net/HttpClient.h"

namespace tcos {

/**
 * Where a downloaded track goes. platform/TrackPlayer wraps the SDK's
 * base::MediaPlayer; the host self-check needs none, because the decisions
 * below are returned as a Plan rather than acted on. The link serialises every
 * call it makes here, so an implementation need not lock.
 */
class AudioSink {
 public:
  virtual ~AudioSink() {}
  /** Starts `path` from the beginning. False when the decoder refused it. */
  virtual bool play(const std::string& path) = 0;
  virtual void pause() = 0;
  virtual void resume() = 0;
  virtual void stop() = 0;
  virtual void seek(int positionMs) = 0;
};

/** The fields of one `GET /api/music/device/state` document the device acts on. */
struct DeviceMusicState {
  int seq;
  bool remote;          // RMT: the source plays elsewhere (Spotify Connect)
  std::string trackId;  // TID, or "" when the service has nothing selected
  bool play;            // PLAY
  int seekMs;           // SEEK, -1 when none is pending

  DeviceMusicState() : seq(-1), remote(false), play(false), seekMs(-1) {}
};

/**
 * The clock as the NetEase player.
 *
 * WHY. The official firmware cannot decode audio, so the speaker in this
 * device was only ever reachable through the sideloaded lyrics player
 * (ADR 0002) — a second firmware, mutually exclusive with this one. ADR 0014
 * retires that firmware; this is the one thing it did that ZOS did not.
 *
 * SAME PROTOCOL, NOT A NEW ONE. The service already has a device-facing music
 * API that the sideloaded player spoke — `/state` polled every two seconds,
 * `/audio` downloaded to tmpfs, `/heartbeat` while a track is loaded, `/report`
 * for a local key press — and the console already knows how to be a silent
 * remote for a device that answers on it. Speaking the same four endpoints
 * means the service needs no new route, the console no new mode, and the
 * behaviour the browser shows was verified on hardware once already.
 *
 * TWO IDENTITIES, DELIBERATELY. The poll carries `?viewer=zos`, which the
 * service does not count as a sideload-firmware poll: FWPOLL is what tells the
 * console "a sideload holds the device, lock every other view", and under ZOS
 * that is false — channels and the mirror keep working. Only the HEARTBEAT,
 * sent only while a track is actually loaded here and the source is not
 * remote, tells the console the clock is the player. So flipping the switch
 * off is enough to hand playback back to the browser: the heartbeats stop and
 * ten seconds later the console is the player again.
 *
 * BEHIND A DEVICE-SIDE SWITCH (设置 → 音乐播放), default 控制台. When this path
 * fails on a unit — a decoder that will not open the file, an output the
 * effects mixer already holds — the browser is the only other speaker, and a
 * heartbeat from here is exactly what tells the browser to fall silent. A
 * default of "on" would therefore turn one bad build into a device with no
 * music at all, and the switch has to be on the device because the device is
 * where the fault is observed.
 *
 * THE PLAYHEAD IS A LOCAL CLOCK, not MediaPlayer::currentPositon(). The
 * sideloaded player kept its own clock too and never read the decoder's; the
 * lyric timing the browser derives from the heartbeat was tuned against that
 * clock on hardware, so this keeps the same one. A seek re-anchors it; a pause
 * freezes it; the decoder's own opinion is never consulted.
 *
 * DECISIONS ARE RETURNED, NOT PERFORMED. applyState() and noteTrackLoaded()
 * take a document and give back a Plan; the worker thread executes it against
 * the sink and the network. That split is what lets the host self-check drive
 * every transition — first document, same sequence again, a pause, a seek, a
 * track change mid-download, a remote source — without a socket or a decoder,
 * which on this device is the only place such a check can run.
 */
class DeviceAudioLink {
 public:
  /** What the worker should do to the sink and the network after a document. */
  struct Plan {
    bool fetch;           // download `trackId` from /audio, then noteTrackLoaded
    std::string trackId;
    bool play;            // sink.play(trackPath()) — set by noteTrackLoaded only
    bool stop;            // sink.stop() and drop the file
    int seekMs;           // >= 0: sink.seek
    int setPlaying;       // -1 nothing, 0 pause, 1 resume

    Plan() : fetch(false), play(false), stop(false), seekMs(-1), setPlaying(-1) {}
    bool empty() const {
      return !fetch && !play && !stop && seekMs < 0 && setPlaying < 0;
    }
  };

  // The sideloaded player's cadence, unchanged: the console's "device is
  // loading" and "device went quiet" windows were sized against it.
  static const int kPollMs = 2000;
  // Where the track lands. The same path the sideloaded player used, so the
  // installer's cleanup list and the README's "rm before pushing" advice stay
  // true, and so a unit that once ran that player has no second stale file.
  static const char* trackPath();
  static const char* partPath();
  // A 320 kbps ten-minute track is ~24 MB; the service streams NetEase at its
  // "standard" level, which is well under that. What the cap guards is tmpfs on
  // a 36 MB device, where a runaway body is a reboot rather than an error.
  static const long kMaxTrackBytes = 24L * 1024 * 1024;
  // After a failed download the next attempt waits this long. The sideloaded
  // player never retried at all — a transient LAN hiccup left that track
  // silent until the next selection.
  static const int kRetryMs = 10000;

  // ---- pure --------------------------------------------------------------

  /** One "KEY\tVALUE" line's value; "" when absent. CR and trailing spaces dropped. */
  static std::string field(const std::string& body, const char* key);
  /** False when the body carries no SEQ at all — not a state document. */
  static bool parseState(const std::string& body, DeviceMusicState* out);
  /** The exact body the sideloaded player sent; the service parses nothing else. */
  static std::string heartbeatBody(const std::string& trackId, int playheadMs, bool playing);
  /** `{"playing":true}` — the one report the service understands outside remote mode. */
  static std::string playingReportBody(bool playing);

  DeviceAudioLink();
  ~DeviceAudioLink();

  /** Must precede start(). Never owned. */
  void setSink(AudioSink* sink);

  /** `baseUrl` like "http://192.168.8.185:43820". Idempotent while running. */
  void start(const std::string& baseUrl);
  /** Joins the worker, silences the sink, removes the file. */
  void stop();
  bool active() const { return mRunning; }

  /**
   * UI thread: flip play/pause NOW and tell the service.
   *
   * The sink call happens here rather than on the next poll because a play
   * button that answers two seconds later reads as a dropped press. The report
   * is `{"playing":X}` — the field the service's control patch understands —
   * so the console echoes the new state on its own next poll and the next
   * document here agrees with what the sink is already doing.
   */
  void togglePlay(uint64_t nowMs);

  bool hasTrack() const;
  bool playing() const;
  int playheadMs(uint64_t nowMs) const;

  /**
   * The decision half of one poll. Public so the host check can drive it; the
   * worker calls it under the state lock and executes the Plan outside it.
   */
  Plan applyState(const DeviceMusicState& state, uint64_t nowMs);
  /** After a fetch finished. A stale id (the track moved on) yields a new fetch. */
  Plan noteTrackLoaded(const std::string& trackId, bool ok, uint64_t nowMs);
  /** The sink reached the end of the file. Freezes the clock; the console decides what is next. */
  void noteCompleted(uint64_t nowMs);
  /** True while a heartbeat would be honest: a track is loaded and the source is not remote. */
  bool wantsHeartbeat() const;

 private:
  static void* workerMain(void* self);
  void runWorker();
  void execute(const Plan& plan, uint64_t nowMs);
  bool download();
  void dropFile();
  void anchor(int positionMs, uint64_t nowMs);

  // The streamGet sink for /audio, written the way FirmwareUpdate writes an
  // image: judged on the declared length before a file is opened, landed in a
  // .part, renamed only when the last declared byte has arrived.
  static bool onReady(void* ctx, const HttpClient::Response& head, long declared);
  static bool onData(void* ctx, const char* bytes, size_t count);

  AudioSink* mSink;
  std::string mBaseUrl;
  volatile bool mRunning;
  bool mThreadStarted;
  pthread_t mThread;
  // Two locks, never nested: mLock is the state the UI reads at frame rate,
  // mSinkLock serialises the decoder, whose play() can take a hundred
  // milliseconds — long enough to drop frames if the UI waited on it.
  mutable pthread_mutex_t mLock;
  pthread_mutex_t mSinkLock;

  // Guarded by mLock.
  int mSeq;
  bool mRemote;
  std::string mTrackId;   // selected by the service; "" when nothing is
  bool mLoaded;           // the file for mTrackId is on disk and in the sink
  bool mPlaying;
  int mAnchorMs;          // position at mAnchorAtMs
  uint64_t mAnchorAtMs;
  int mSeekApplied;
  uint64_t mRetryAtMs;    // 0 when no retry is pending
  std::vector<std::string> mReports;

  // Download state, worker thread only.
  FILE* mFile;
  long mReceived;
};

}  // namespace tcos

#endif  // NET_DEVICEAUDIO_H_
