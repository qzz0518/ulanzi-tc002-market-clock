#ifndef PAGES_VOLUMEPAGE_H_
#define PAGES_VOLUMEPAGE_H_

#include <stdint.h>
#include "pages/PageBase.h"

class Surface;

// Transient overlay shown while the knob adjusts volume: a boba-cup whose fill
// level maps to the 0..6 hardware volume ("drink size"), with a big level digit.
class VolumePage : public PageBase {
public:
	explicit VolumePage(const std::string& name);
	virtual ~VolumePage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;

	void setVolume(int v) { mVolume = v; }
	void setSkin(int skin) { mSkin = skin; }

private:
	int mVolume;
	int mSkin;
};

#endif  // PAGES_VOLUMEPAGE_H_
