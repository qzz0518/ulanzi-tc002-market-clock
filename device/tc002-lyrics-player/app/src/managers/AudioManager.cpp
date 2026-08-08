#include <managers/AudioManager.h>
#include <manager/ConfigManager.h>
namespace awtrix {

AudioManager::AudioManager() {
	pPlayer.reset(new base::MediaPlayer());
	base::AudioManager::instance().setIdleTimeout(0);
}

AudioManager& AudioManager::getInstance() {
	static AudioManager single;
	return single;
}

void AudioManager::stopAudio() {
	pPlayer->stop();
}

void AudioManager::playAudio(const std::string& path) {
	pPlayer->play(path);
}

void AudioManager::pauseAudio() {
	pPlayer->pause();
}

void AudioManager::resumeAudio() {
	pPlayer->resume();
}

void AudioManager::seekAudio(int64_t ms) {
	if (ms < 0) ms = 0;
	if (!pPlayer || !pPlayer->isPlaying()) return;
	pPlayer->seekTo(ms);
}

bool AudioManager::isPlaying() const {
	return pPlayer->isPlaying();
}

void AudioManager::setMute(bool isMute) {
	base::AudioManager::instance().setMute(isMute);
}

void AudioManager::setVolume(int lv) {
	int volume = lv;
	switch(lv) {
	case 0:
		volume = 0;
		break;
	case 1:
		volume = 15;
		break;
	case 2:
		volume = 17;
		break;
	case 3:
		volume = 19;
		break;
	case 4:
		volume = 21;
		break;
	case 5:
		volume = 23;
		break;
	case 6:
		volume = 25;
		break;
	default:
		break;
	}
	if(volume == 0) {
		base::AudioManager::instance().setMute(true);
	}
	else {
		base::AudioManager::instance().setVolume(volume);
		base::AudioManager::instance().setMute(false);
	}

}

AudioManager::~AudioManager() {
	pPlayer = nullptr;
}

} /* namespace awtrix */
