#ifndef MANAGERS_SFXMANAGER_H_
#define MANAGERS_SFXMANAGER_H_

#include <string>
#include <memory>

namespace base { class MediaPlayer; }

// Game sound effects played through base::MediaPlayer — the one audio path
// proven on real hardware by the music firmware (the AudioPlayer/putSamples
// fast path stayed silent on the device). One shared player instance: a new
// trigger stops whatever is still sounding, which is inaudible for these
// 30-600ms clips and keeps ffmpeg's per-player threads to a single set on a
// 36MB device. Trigger latency is demux+decode of a tiny local wav (tens of
// ms) — acceptable for jingles.
class SfxManager {
public:
	enum SoundId {
		SFX_BOOT = 0,   // splash entry arpeggio
		SFX_TICK,       // menu selection detent
		SFX_CONFIRM,    // enter game / game start
		SFX_SCORE,      // score gained
		SFX_OVER,       // game over
		SFX_COUNT
	};

	static SfxManager& getInstance();

	// Remember <dir>/{boot,tick,confirm,score,over}.wav paths (files must
	// exist; missing clips just no-op) and set the mixer idle timeout.
	// Call from init only. Returns the number of clips found.
	int init(const std::string& dir);

	void play(SoundId id);

private:
	SfxManager();
	~SfxManager();
	SfxManager(const SfxManager&) = delete;
	SfxManager& operator=(const SfxManager&) = delete;

	std::string mPath[SFX_COUNT];
	std::unique_ptr<base::MediaPlayer> mPlayer;
};

#endif  // MANAGERS_SFXMANAGER_H_
