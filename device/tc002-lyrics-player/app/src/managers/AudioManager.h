#ifndef AWTRIX_MANAGERS_AUDIOMANAGER_H_
#define AWTRIX_MANAGERS_AUDIOMANAGER_H_

#include "media_player.h"
#include "audio_manager.h"
#include <memory>
namespace awtrix {

class AudioManager {
public:
	static AudioManager& getInstance();
	AudioManager(AudioManager&) = delete;
	AudioManager& operator=(AudioManager&) = delete;
	void playAudio(const std::string& path);
	void stopAudio();
	void pauseAudio();
	void resumeAudio();
	void seekAudio(int64_t ms);
	bool isPlaying() const;
	//0~6 0禁音
	void setVolume(int lv);
	void setMute(bool isMute);
private:
	AudioManager();
	virtual ~AudioManager();
	std::unique_ptr<base::MediaPlayer>pPlayer;
	std::string mBtnAudioPath;
	std::string mTipAudioPath;
	std::string mClockPath;
};

} /* namespace awtrix */

#endif /* AWTRIX_MANAGERS_AUDIOMANAGER_H_ */
