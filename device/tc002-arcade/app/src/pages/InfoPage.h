#ifndef PAGES_INFOPAGE_H_
#define PAGES_INFOPAGE_H_

#include <string>
#include "pages/PageBase.h"

// Device info in 3x5 text, three lines per screen, auto-cycling between a
// status screen (battery raw pair / USB / volume / uptime) and an identity
// screen (firmware version / MCU version / IP). MCU values arrive through
// setters — the logic's background thread owns the (blocking) MCU queries and
// pushes its cache in every tick; this page never touches the serial link.
// Input: knob rotation nudges the volume (the logic polls takeVolumeDelta(),
// applies it to its session-static level and pushes the result back through
// setVolume; the page jumps to the status screen so VOL is visible while
// turning), middle flips screens, knob press or left goes back, right arms
// the two-press power-off confirm (MCU 0x10). The logic polls
// takeBack()/takePowerOff() as before.
class InfoPage : public PageBase {
public:
	explicit InfoPage(const std::string& name);
	virtual ~InfoPage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;
	virtual bool onKeyEvent(int keyCode, int keyStatus) override;

	void tick();

	// Cached values pushed by the logic (UI thread, every info tick).
	void setBattery(int rawA, int rawB);   // MCU 0x03 pair, semantics unsettled
	void setUsb(int state);
	void setMcuVersion(const std::string& ver);
	void setVolume(int level);

	bool takeBack();        // one-shot: leave to the menu
	bool takePowerOff();    // one-shot: confirmed power-off request
	int takeVolumeDelta();  // one-shot: net knob detents since last poll

private:
	std::string ipAddress() const;
	long uptimeSeconds() const;

	int mBatA, mBatB;
	int mUsb;
	int mVolume;
	std::string mMcuVer;
	std::string mIp;
	long mUptimeSec;

	int mTicks;
	int mArmTicks;         // >0 while the power-off confirm window is open
	int mVolDelta;         // accumulated knob detents pending takeVolumeDelta
	bool mBack;
	bool mPowerOff;
};

#endif  // PAGES_INFOPAGE_H_
