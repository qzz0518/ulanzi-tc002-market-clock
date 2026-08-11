#ifndef PLATFORM_SFX_H_
#define PLATFORM_SFX_H_

namespace tcos {

/**
 * Sound effects, synthesised rather than played back.
 *
 * The arcade firmware ships .wav clips and decodes them through MediaPlayer,
 * which drags in ffmpeg: measured at ~1.1 MB of .text plus 856 KB of .bss. For
 * a handful of short beeps that is an absurd price. These are generated —
 * square, triangle and noise waveforms with a frequency sweep and a decay
 * envelope, written straight into base::AudioPlayer, a PCM sink with no decoder
 * behind it. Same reasoning as the icons being drawn rather than stored: on
 * this device code is cheaper than assets.
 *
 * Shell sounds belong to the OS and are the same everywhere. GAME sounds are
 * per game: seven games sharing one blip is the audio equivalent of the seven
 * identical icons — it tells the player nothing about what they are playing.
 */
class Sfx {
 public:
  // The shell's own vocabulary, identical in every screen.
  enum Clip {
    kTick,     // one knob detent
    kConfirm,  // a press that did something
    kBack,     // leaving a screen
    kClipCount,
  };

  // What just happened inside a game. Each game voices these differently.
  enum GameEvent {
    kGameStart,
    kGameScore,
    kGameOver,
    kGameEventCount,
  };

  // Index into the games list, in launcher order.
  enum Game {
    kBreakout = 0,
    kFlappy = 1,
    kSnake = 2,
    kPong = 3,
    kRacer = 4,
    kShooter = 5,
    kTetris = 6,
    kGameCount = 7,
  };

  /**
   * One synthesised sound: a waveform swept from one frequency to another over
   * a duration, with a linear decay. Public because the voice tables live in
   * the .cpp's anonymous namespace, which is where per-game tuning belongs.
   */
  struct Voice {
    int wave;        // Wave enum in the .cpp: square, triangle or noise
    int freqStart;
    int freqEnd;     // swept linearly; equal to freqStart for a flat tone
    int durationMs;
    float volume;
  };

  static Sfx& instance();

  /** Opens the audio device. Safe to call more than once; failures are silent. */
  void initialize();

  void play(Clip clip);
  void playGame(int game, GameEvent event);

  /** Maps an engine's id() string to a Game, or -1. */
  static int gameFromId(const char* id);

  void setMuted(bool muted) { mMuted = muted; }
  bool muted() const { return mMuted; }
  bool available() const { return mReady; }

 private:
  Sfx();
  Sfx(const Sfx&);
  Sfx& operator=(const Sfx&);

  void emit(const Voice& voice);

  struct Impl;
  Impl* mImpl;
  bool mReady;
  bool mMuted;
  unsigned int mNoiseState;
  int mTraceCount;
};

}  // namespace tcos

#endif  // PLATFORM_SFX_H_
