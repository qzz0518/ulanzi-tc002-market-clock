#ifndef PAGES_SPLASHPAGE_H_
#define PAGES_SPLASHPAGE_H_

#include <stdint.h>
#include "pages/PageBase.h"

// Boot splash, ~3s at a 40ms tick: "PIXEL" then "ARCADE" wordmarks sweep in
// with a shine (6x12 LatinFont), the four game icons light up one by one, and
// a progress bar fills along the bottom row. Plays the boot sfx on enter.
// Any button press (not the knob rotation) skips straight to the menu.
class SplashPage : public PageBase {
public:
	explicit SplashPage(const std::string& name);
	virtual ~SplashPage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;
	virtual bool onKeyEvent(int keyCode, int keyStatus) override;

	void tick();
	int getTickIntervalMs() const { return 40; }   // ~25 fps
	bool isDone() const;

private:
	uint32_t mElapsedMs;
	bool mSkipped;
};

#endif  // PAGES_SPLASHPAGE_H_
