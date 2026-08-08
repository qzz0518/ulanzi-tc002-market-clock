#ifndef PAGES_SPLASHPAGE_H_
#define PAGES_SPLASHPAGE_H_

#include <stdint.h>
#include "pages/PageBase.h"

// Boot splash: a ~6s five-scene 52x16 animation — CRT power-on scanline,
// "PIXEL" dropping in and bouncing, a shine-swept "MUSIC" wordmark, spectrum
// rise with the note icon, then a fade-out into the lyrics page.
class SplashPage : public PageBase {
public:
	explicit SplashPage(const std::string& name);
	virtual ~SplashPage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;

	void tick();
	int getTickIntervalMs() const { return 40; }   // ~25 fps
	bool isDone() const { return mProgress >= 1.0f; }

private:
	float mProgress;
	uint32_t mElapsedMs;
};

#endif  // PAGES_SPLASHPAGE_H_
