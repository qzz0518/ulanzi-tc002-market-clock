#ifndef PAGES_MENUPAGE_H_
#define PAGES_MENUPAGE_H_

#include "pages/PageBase.h"

// Horizontal cartridge picker: eight 12x12 icons (seven games + INFO)
// scrolling with a two-frame ease, the selected one framed in arcade red.
// The bottom 3x5 line alternates between the selected title and a
// "PRESS TO ..." hint, bouncing InfoPage-style when wider than the panel;
// a y=15 dot rail shows the page position and a few muted background stars
// twinkle behind the strip. Input is handled here (PageManager::onKeyEvent
// routes to the current page); the logic polls takeAction() every tick for
// the resulting navigation.
class MenuPage : public PageBase {
public:
	explicit MenuPage(const std::string& name);
	virtual ~MenuPage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;
	virtual bool onKeyEvent(int keyCode, int keyStatus) override;

	void tick();
	// One-shot: -1 = nothing, 0..6 = enter that game slot, 7 = open the info
	// page (either the INFO cartridge or the left/right shortcut buttons).
	int takeAction();
	int selectedSlot() const { return mSelected; }

private:
	int mSelected;      // 0..7 (7 = INFO)
	int mAction;        // pending takeAction() value, -1 when none
	int mShiftFrom;     // px offset the strip eases back from after a move
	int mEaseTick;      // frames since the move; 2 transitional frames
	int mTicks;         // page-local frame counter (30ms per tick)
};

#endif  // PAGES_MENUPAGE_H_
