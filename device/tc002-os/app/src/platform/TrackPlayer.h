#ifndef PLATFORM_TRACKPLAYER_H_
#define PLATFORM_TRACKPLAYER_H_

#include "net/DeviceAudio.h"

namespace base {
class MediaPlayer;
}

namespace tcos {

/**
 * The SDK's base::MediaPlayer behind the AudioSink the device audio link
 * drives: a file in tmpfs in, MI_AO out, the decode path being the static
 * ffmpeg archives the sideloaded player linked for the same job.
 *
 * Device-only by construction — media_player.h has no host build — which is
 * why every decision lives in net/DeviceAudio and this is five forwarding
 * calls. The one thing it adds is the completion callback: the decoder's own
 * thread reports the end of the file, and the link needs to know so the
 * heartbeat stops claiming playback.
 */
class TrackPlayer : public AudioSink {
 public:
  static TrackPlayer& instance();

  bool play(const std::string& path);
  void pause();
  void resume();
  void stop();
  void seek(int positionMs);

  /** Called on the decoder's thread when a file ends. */
  void onCompletion(void (*fn)(void* ctx), void* ctx);

 private:
  TrackPlayer();
  ~TrackPlayer();
  TrackPlayer(const TrackPlayer&);
  TrackPlayer& operator=(const TrackPlayer&);

  base::MediaPlayer* mPlayer;  // created on first play, when the mixer is up
  void (*mCompletion)(void*);
  void* mCompletionCtx;
};

}  // namespace tcos

#endif  // PLATFORM_TRACKPLAYER_H_
