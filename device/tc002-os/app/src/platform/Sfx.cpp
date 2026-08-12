#include "platform/Sfx.h"

#include <stdint.h>
#include <string.h>

#include <vector>

#include "audio_manager.h"
#include "audio_player.h"
#include "audio_parameter.h"
#include "base/log.h"

namespace tcos {

namespace {

const int kSampleRate = 16000;  // ample for these timbres, and a third of the
                                // buffer 48 kHz would need for the same length
enum Wave { kSquare, kTriangle, kNoise };

// The shell's own sounds. Deliberately plain — they punctuate navigation and
// must not compete with whatever game is running.
const Sfx::Voice kShell[Sfx::kClipCount] = {
  {kSquare,   1200, 1200,  18, 0.38f},  // tick: barely there, one per detent
  {kTriangle,  880, 1320,  55, 0.72f},  // confirm: rising
  {kTriangle, 1320,  880,  55, 0.62f},  // back: the same interval, falling
};

// Per game. The score sound is the one a player hears hundreds of times, so it
// carries the identity; start and over frame the session.
//
//                       wave       from    to    ms   vol
const Sfx::Voice kGames[Sfx::kGameCount][Sfx::kGameEventCount] = {
  // BREAKOUT — a hard brick click, bright and instant.
  { {kSquare,    440,  660,  70, 0.77f},
    {kSquare,   1760, 1760,  22, 0.82f},
    {kTriangle,  520,  180, 200, 0.82f} },
  // FLAPPY — soft round blips; the pipe-pass is a clean two-step ding.
  { {kTriangle,  520,  780,  80, 0.72f},
    {kTriangle, 1046, 1568,  60, 0.72f},
    {kTriangle,  700,  160, 260, 0.77f} },
  // SNAKE — a short swallow that rises, nothing metallic.
  { {kTriangle,  392,  588,  70, 0.72f},
    {kTriangle,  660,  990,  45, 0.72f},
    {kSquare,    330,  110, 240, 0.72f} },
  // PONG — the iconic flat square blip, unchanged from the arcade original.
  { {kSquare,    600,  600,  60, 0.72f},
    {kSquare,    990,  990,  40, 0.77f},
    {kSquare,    260,  260, 180, 0.72f} },
  // RACER — engine-ish sweeps; the crash is noise, which no tone can imitate.
  { {kSquare,    180,  520, 120, 0.67f},
    {kSquare,    880, 1320,  50, 0.67f},
    {kNoise,     900,  120, 260, 0.82f} },
  // SHOOTER — a fast downward laser, and a noise burst for the hit.
  { {kSquare,   1400,  400,  90, 0.72f},
    {kNoise,    1800,  600,  45, 0.72f},
    {kNoise,     700,   90, 320, 0.82f} },
  // TETRIS — a low lock thunk, a bright rising clear.
  { {kSquare,    220,  220,  70, 0.72f},
    {kTriangle,  660, 1320,  90, 0.77f},
    {kSquare,    300,   90, 260, 0.72f} },
};

}  // namespace

struct Sfx::Impl {
  Impl()
      : parameter(1, kSampleRate, base::SAMPLE_FMT_S16),
        player(parameter) {}
  base::AudioParameter parameter;
  base::AudioPlayer player;
  std::vector<uint8_t> scratch;
};

Sfx::Sfx() : mImpl(0), mReady(false), mMuted(false), mNoiseState(0x1234567u) {}

Sfx& Sfx::instance() {
  static Sfx single;
  return single;
}

int Sfx::gameFromId(const char* id) {
  if (id == 0) return -1;
  static const char* kIds[kGameCount] = {
      "breakout", "flappy", "snake", "pong", "racer", "shooter", "tetris"};
  for (int i = 0; i < kGameCount; ++i) {
    if (::strcmp(id, kIds[i]) == 0) return i;
  }
  return -1;
}

void Sfx::initialize() {
  if (mReady) return;
  mImpl = new Impl();
  if (mImpl->player.play() != 0) {
    // No audio device is not worth stopping for: the panel is the product.
    LOGE_TRACE("sfx: audio device unavailable, running silent");
    delete mImpl;
    mImpl = 0;
    return;
  }

  // THE reason the firmware went silent. AudioManager closes the output when no
  // player has fed it for `idleTimeout`, which defaults to one second. These
  // effects are 18-320 ms and land many seconds apart, so every single one fell
  // inside the codec's cold start and was swallowed whole. The arcade firmware
  // never hit this because it plays multi-second .wav files: there the warm-up
  // hides in the attack.
  // ZERO, which means "never close", and it is the vendor's own choice:
  // Z21_TC002_Demo/src/managers/AudioManager.cpp does nothing in its
  // constructor except setIdleTimeout(0). The ten-minute value this replaces
  // did not fix the swallowed-first-sound bug, it merely re-armed it on a
  // longer fuse — ten quiet minutes on a carousel channel is not a rare state,
  // it is the normal one.
  base::AudioManager::instance().setIdleTimeout(0);

  // Mute is global and survives whatever ran before us — the official firmware,
  // the arcade build, a previous ZOS session that was left at volume 0. Nothing
  // else ever clears it, so an inherited mute would look exactly like "sound is
  // broken" with no way back.
  base::AudioManager::instance().setMute(false);

  // Prime the output with a short silence so the first real effect meets an
  // already-open device rather than opening it.
  std::vector<uint8_t> silence(kSampleRate / 10 * 2, 0);  // 100 ms
  mImpl->player.putSamples(&silence[0], static_cast<int>(silence.size()));

  mReady = true;
}

void Sfx::emit(const Voice& voice) {
  if (!mReady || mMuted || mImpl == 0) return;

  // Drop a sound only when there is a REAL backlog, not merely because the sink
  // reports a non-zero residue. The first version skipped on `busyCount() > 0`,
  // which silenced the firmware completely: the mixer keeps bytes queued while
  // running, so that condition was true forever. The threshold is a quarter
  // second of audio — enough that rapid scoring stays a rhythm instead of a
  // smear, but never so tight that it mutes everything.
  const int busy = mImpl->player.busyCount();
  if (busy > kSampleRate / 2) return;  // 8000 bytes = 250 ms at 16 kHz mono S16

  const int samples = (kSampleRate * voice.durationMs) / 1000;
  if (samples <= 0) return;
  mImpl->scratch.resize(static_cast<size_t>(samples) * 2);

  int phase = 0;
  int period = 0;
  for (int i = 0; i < samples; ++i) {
    const float through = static_cast<float>(i) / samples;

    // Recompute the period every 32 samples rather than every one: at 16 kHz
    // that is a 2 ms step, inaudible as a staircase and a fraction of the cost.
    if ((i & 31) == 0) {
      const int freq = voice.freqStart +
                       static_cast<int>((voice.freqEnd - voice.freqStart) * through);
      period = freq > 0 ? kSampleRate / freq : 0;
      if (period < 2) period = 2;
    }

    const float envelope = 1.0f - through;  // linear; a powf per sample buys
                                            // nothing audible on a 60 ms beep
    const int amplitude = static_cast<int>(32767.0f * voice.volume * envelope);

    int16_t value = 0;
    switch (static_cast<Wave>(voice.wave)) {
      case kSquare:
        value = static_cast<int16_t>(phase < period / 2 ? amplitude : -amplitude);
        break;
      case kTriangle: {
        // Softer than a square at the same level, which is what keeps the shell
        // sounds from cutting through a game.
        const int half = period / 2;
        const int up = phase < half ? phase : period - phase;
        value = static_cast<int16_t>((2 * amplitude * up) / (half > 0 ? half : 1) - amplitude);
        break;
      }
      case kNoise:
      default: {
        // An explosion cannot be faked with a tone. The sweep still applies:
        // `period` throttles how often a new random level is taken, so a
        // descending sweep darkens the noise as it decays.
        mNoiseState = mNoiseState * 1664525u + 1013904223u;
        if (phase == 0) {
          value = static_cast<int16_t>(
              (static_cast<int>((mNoiseState >> 16) & 0xFFFF) - 32768) * voice.volume * envelope);
        } else {
          value = static_cast<int16_t>(
              (static_cast<int>((mNoiseState >> 16) & 0xFFFF) - 32768) * voice.volume * envelope * 0.6f);
        }
        break;
      }
    }

    mImpl->scratch[i * 2] = static_cast<uint8_t>(value & 0xFF);
    mImpl->scratch[i * 2 + 1] = static_cast<uint8_t>((value >> 8) & 0xFF);
    if (period > 0 && ++phase >= period) phase = 0;
  }

  mImpl->player.putSamples(&mImpl->scratch[0], static_cast<int>(mImpl->scratch.size()));

}

void Sfx::play(Clip clip) {
  if (clip < 0 || clip >= kClipCount) return;
  emit(kShell[clip]);
}

void Sfx::playGame(int game, GameEvent event) {
  if (game < 0 || game >= kGameCount) return;
  if (event < 0 || event >= kGameEventCount) return;
  emit(kGames[game][event]);
}

}  // namespace tcos
