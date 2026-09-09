#include "platform/TrackPlayer.h"

#include "media_player.h"

namespace tcos {

TrackPlayer& TrackPlayer::instance() {
  static TrackPlayer single;
  return single;
}

TrackPlayer::TrackPlayer() : mPlayer(0), mCompletion(0), mCompletionCtx(0) {}

TrackPlayer::~TrackPlayer() {
  delete mPlayer;
}

bool TrackPlayer::play(const std::string& path) {
  if (mPlayer == 0) {
    // Lazily, and after Sfx::initialize() has set the mixer's idle timeout to
    // zero: the sideloaded player constructed its MediaPlayer in the same
    // order, and an output that closes itself between tracks was the failure
    // that setting exists to prevent.
    mPlayer = new base::MediaPlayer();
    TrackPlayer* self = this;
    mPlayer->onCompletion([self]() {
      if (self->mCompletion != 0) self->mCompletion(self->mCompletionCtx);
    });
  }
  mPlayer->stop();
  return mPlayer->play(path) == 0;
}

void TrackPlayer::pause() {
  if (mPlayer != 0) mPlayer->pause();
}

void TrackPlayer::resume() {
  if (mPlayer != 0) mPlayer->resume();
}

void TrackPlayer::stop() {
  if (mPlayer != 0) mPlayer->stop();
}

void TrackPlayer::seek(int positionMs) {
  // The sideloaded player refused seeks while stopped, because the SDK's
  // seekTo on an idle player is a no-op that returns nothing; a paused player
  // seeks fine.
  if (mPlayer != 0) mPlayer->seekTo(positionMs < 0 ? 0 : positionMs);
}

void TrackPlayer::onCompletion(void (*fn)(void*), void* ctx) {
  mCompletion = fn;
  mCompletionCtx = ctx;
}

}  // namespace tcos
