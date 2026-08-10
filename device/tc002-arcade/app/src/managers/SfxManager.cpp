#include "managers/SfxManager.h"

#include <stdio.h>
#include "media_player.h"
#include "audio_manager.h"
#include "base/log.h"

namespace {

const char* kClipNames[SfxManager::SFX_COUNT] = {
	"boot", "tick", "confirm", "score", "over"
};

bool fileExists(const std::string& path) {
	FILE* f = fopen(path.c_str(), "rb");
	if (!f) return false;
	fclose(f);
	return true;
}

}  // namespace

SfxManager& SfxManager::getInstance() {
	static SfxManager single;
	return single;
}

SfxManager::SfxManager() {}

SfxManager::~SfxManager() {}

int SfxManager::init(const std::string& dir) {
	// 0 has conflicting idle-timeout readings in the two audio surveys; 3000
	// is safe under both and avoids the music firmware's pop risk.
	base::AudioManager::instance().setIdleTimeout(3000);
	mPlayer.reset(new base::MediaPlayer());
	int found = 0;
	for (int i = 0; i < SFX_COUNT; ++i) {
		std::string path = dir + "/" + kClipNames[i] + ".wav";
		if (fileExists(path)) {
			mPath[i] = path;
			++found;
		} else {
			mPath[i].clear();
			LOGW_TRACE("SfxManager: clip [%s] unavailable, muted", path.c_str());
		}
	}
	LOGI_TRACE("SfxManager: %d/%d clips found in [%s]", found, (int)SFX_COUNT, dir.c_str());
	return found;
}

void SfxManager::play(SoundId id) {
	if (id < 0 || id >= SFX_COUNT) return;
	if (!mPlayer || mPath[id].empty()) return;
	// The music firmware's proven change-track pattern: stop, then play the
	// local file. A fresh trigger cutting a still-sounding clip is inaudible
	// at these lengths.
	mPlayer->stop();
	mPlayer->play(mPath[id]);
}
