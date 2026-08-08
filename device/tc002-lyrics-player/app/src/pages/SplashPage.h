#ifndef PAGES_SPLASHPAGE_H_
#define PAGES_SPLASHPAGE_H_

#include <stdint.h>
#include "pages/PageBase.h"

// Boot splash: a ~2.4s 52x16 animation — spectrum bars rise, a note icon
// blooms, the wordmark fades in, then it hands off to the lyrics page.
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
