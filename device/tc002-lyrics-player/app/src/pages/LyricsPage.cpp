#include "pages/LyricsPage.h"

#include <math.h>
#include <stdlib.h>
#include <string>
#include <vector>
#include "utils/Surface.h"
#include "visual/Palette.h"
#include "visual/LatinFont.h"
#include "visual/CjkFont.h"
#include "visual/LyricModes.h"

using namespace lyricsvisual;

namespace {

enum { MODE_TICKER = 0, MODE_SKYLINE = 1, MODE_SPOTLIGHT = 2, MODE_CASCADE = 3, MODE_COUNT = 4 };

const int VIEW_X = 2, VIEW_W = 48;

}  // namespace

LyricsPage::LyricsPage(const std::string& name)
	: PageBase(name), mRemoteDurationMs(0), mPlayheadMs(0), mHasRemote(false),
	  mStarted(false), mLineElapsedMs(0), mLineIndex(0), mPlaying(true),
	  mSkin(SKIN_SIGNAL), mMode(MODE_SPOTLIGHT), mAccentRgb(0), mHasAccent(false), mAnimMs(0) {
	pthread_mutex_init(&mMutex, NULL);
}
LyricsPage::~LyricsPage() { pthread_mutex_destroy(&mMutex); }

void LyricsPage::onEnter() {
	pthread_mutex_lock(&mMutex);
	mPlaying = true;
	pthread_mutex_unlock(&mMutex);
}
void LyricsPage::onExit() {}

// ---- UTF-8 layout ----------------------------------------------------------

int LyricsPage::layoutRow(const char* text, Cell* cells, int maxCells, int& totalWidth) const {
	int n = 0;
	totalWidth = 0;
	const char* p = text;
	while (*p && n < maxCells) {
		uint32_t cp = utf8Next(p);
		// ASCII/Latin-basic renders half-width (6px, latinGlyph); everything else
		// (CJK, kana, full-width punctuation) renders full-width (12px, cjkGlyph).
		bool cjk = !(cp >= 0x20 && cp <= 0x7E);
		cells[n].cp = cp;
		cells[n].width = cjk ? 12 : 6;
		cells[n].cjk = cjk;
		cells[n].startX = totalWidth;
		totalWidth += cells[n].width;
		++n;
	}
	return n;
}

void LyricsPage::blitGlyph(Surface& s, const Cell& cell, int gx, int y, const Color& c,
                           int viewX, int viewW) const {
	if (cell.cjk) {
		const CjkGlyph* g = cjkGlyph(cell.cp);
		if (!g) return;
		for (int row = 0; row < 12; ++row) {
			int ty = y + row;
			if (ty < 0 || ty > 15) continue;
			for (int col = 0; col < 12; ++col)
				if (g->rows[row] & (1 << (11 - col))) {
					int px = gx + col;
					if (px >= viewX && px < viewX + viewW) s.setPixel(px, ty, c);
				}
		}
	} else {
		const LatinGlyph* g = latinGlyph(cell.cp);
		if (!g) return;
		for (int row = 0; row < 12; ++row) {
			int ty = y + row;
			if (ty < 0 || ty > 15) continue;
			for (int col = 0; col < 6; ++col)
				if (g->rows[row] & (1 << (5 - col))) {
					int px = gx + col;
					if (px >= viewX && px < viewX + viewW) s.setPixel(px, ty, c);
				}
		}
	}
}

// lyricScrollOffsetForProgress from the web preview (whole-cell snapped scroll).
int LyricsPage::scrollOffsetFor(int totalWidth, float lyricProgress, int mode) const {
	if (mode == MODE_SPOTLIGHT) return spotlightOffsetPx(totalWidth, lyricProgress);
	int aligned = ((totalWidth + 11) / 12) * 12;
	int travel = aligned - VIEW_W;
	if (travel <= 0) return 0;
	float t = (lm_unit(lyricProgress) - 0.08f) / (0.92f - 0.08f);
	t = lm_unit(t);
	float ss = t * t * (3.f - 2.f * t);
	int cont = (int)lroundf(travel * ss);
	int snapped = (int)lroundf((float)cont / 12.f) * 12;
	if (snapped > travel) snapped = travel;
	return snapped;
}

// ---- progress cue row ------------------------------------------------------

void LyricsPage::cueRow(Surface& s, const Palette& pal, int y, float progress, int trailPx) {
	const int startX = VIEW_X, travel = VIEW_W - 1;  // 47
	s.setPixel(startX, y, pal.muted);
	s.setPixel(startX + (travel / 2), y, pal.muted);
	s.setPixel(startX + travel, y, pal.muted);
	int cursorX = startX + (int)lroundf(travel * lm_unit(progress));
	int trail = trailPx;
	if (trail > cursorX - startX) trail = cursorX - startX;
	for (int i = 0; i < trail; ++i) s.setPixel(cursorX - 1 - i, y, pal.secondary);
	s.setPixel(cursorX, y, pal.primary);
}

// ---- per-mode painters -----------------------------------------------------

void LyricsPage::paintTicker(Surface& s, const FrameCtx& f) {
	const Palette& pal = *f.pal;
	cueRow(s, pal, 0, f.prog, 2);
	cueRow(s, pal, 15, f.track, 1);
	int focus = (int)(f.prog * f.n);
	if (focus >= f.n) focus = f.n - 1;
	int startX = f.totalW <= VIEW_W ? (52 - f.totalW) / 2
		: VIEW_X - scrollOffsetFor(f.totalW, f.prog, MODE_TICKER);
	for (int i = 0; i < f.n; ++i) {
		const Color& c = (i < focus) ? pal.secondary : (i == focus ? pal.primary : pal.context);
		blitGlyph(s, f.cells[i], startX + f.cells[i].startX, 2, c, VIEW_X, VIEW_W);
	}
}

void LyricsPage::paintSkyline(Surface& s, const FrameCtx& f) {
	const Palette& pal = *f.pal;
	bool showText = f.hasLyric || !f.playing;
	int maxLevel = showText ? 3 : 12;
	float kick = beatKick(f.playing, f.hasLyric, f.prog, f.n, f.animMs);
	for (int bar = 0; bar < SKYLINE_BARS; ++bar) {
		int x = 1 + bar * 3;
		int level = skylineBarLevel(bar, f.animMs, f.playing, kick, maxLevel);
		s.setPixel(x, 15, pal.muted);
		s.setPixel(x + 1, 15, pal.muted);
		for (int step = 1; step <= level; ++step) {
			const Color& c = (level <= 1) ? pal.muted
				: (step == level && level == maxLevel ? pal.primary : pal.secondary);
			s.setPixel(x, 15 - (step - 1), c);
			s.setPixel(x + 1, 15 - (step - 1), c);
		}
	}
	if (!showText) return;
	int focus = (int)(f.prog * f.n);
	if (focus >= f.n) focus = f.n - 1;
	int startX = f.totalW <= VIEW_W ? (52 - f.totalW) / 2
		: VIEW_X - scrollOffsetFor(f.totalW, f.prog, MODE_SKYLINE);
	for (int i = 0; i < f.n; ++i) {
		const Color& c = (i < focus) ? pal.secondary : (i == focus ? pal.primary : pal.context);
		blitGlyph(s, f.cells[i], startX + f.cells[i].startX, 0, c, VIEW_X, VIEW_W);
	}
}

void LyricsPage::paintSpotlight(Surface& s, const FrameCtx& f) {
	const Palette& pal = *f.pal;
	s.setPixel(19, 1, pal.muted);
	s.setPixel(32, 1, pal.muted);
	cueRow(s, pal, 15, f.track, 1);
	float focusPx = lm_unit(f.prog) * f.totalW;
	int spanStarts[96];
	int limit = f.n < 96 ? f.n : 96;
	for (int i = 0; i < limit; ++i) spanStarts[i] = f.cells[i].startX;
	int focusIndex = spanIndexAtPx(spanStarts, limit, (int)focusPx);
	int offset = spotlightOffsetPx(f.totalW, f.prog);  // screen x of the bitmap's left edge
	for (int i = 0; i < f.n; ++i) {
		int dist = i - focusIndex;
		if (dist < 0) dist = -dist;
		const Color& c = dist == 0 ? pal.primary : (dist == 1 ? pal.secondary : pal.context);
		blitGlyph(s, f.cells[i], offset + f.cells[i].startX, 2, c, 0, 52);
	}
	if (focusIndex < 0 || focusIndex >= f.n) return;
	const Cell& span = f.cells[focusIndex];
	float frac = lm_unit((focusPx - span.startX) / (float)(span.width > 0 ? span.width : 1));
	int barW = (int)lroundf(frac * 12.f);
	for (int i = 0; i < barW; ++i) s.setPixel(20 + i, 14, pal.secondary);
}

void LyricsPage::paintCascade(Surface& s, const FrameCtx& f) {
	const Palette& pal = *f.pal;
	int fill = (int)lroundf(lm_unit(f.track) * 16.f);
	for (int step = 0; step < fill; ++step) {
		const Color& c = (step == fill - 1) ? pal.primary : pal.muted;
		s.setPixel(51, 15 - step, c);
	}
	int phase = cascadePhase(f.prog, false);
	int bandY = cascadeBandY(f.prog, false);
	int focus = (int)(f.prog * f.n);
	if (focus >= f.n) focus = f.n - 1;
	int startX = f.totalW <= VIEW_W ? (52 - f.totalW) / 2
		: VIEW_X - scrollOffsetFor(f.totalW, f.prog, MODE_CASCADE);
	for (int i = 0; i < f.n; ++i) {
		Color c;
		if (phase == CASCADE_ENTER) c = pal.secondary;
		else if (phase == CASCADE_EXIT) c = pal.context;
		else c = (i < focus) ? pal.secondary : (i == focus ? pal.primary : pal.context);
		blitGlyph(s, f.cells[i], startX + f.cells[i].startX, bandY, c, VIEW_X, VIEW_W);
	}
}

// ---- draw ------------------------------------------------------------------

void LyricsPage::draw() {
	std::string text;
	float prog = 0.f, track = 0.f, animMs = 0.f;
	bool playing = true, hasLyric = false;
	int skin = SKIN_SIGNAL, mode = MODE_SPOTLIGHT;
	uint32_t accentRgb = 0;
	bool hasAccent = false;

	pthread_mutex_lock(&mMutex);
	playing = mPlaying;
	skin = mSkin;
	mode = mMode;
	accentRgb = mAccentRgb;
	hasAccent = mHasAccent;
	animMs = (float)mAnimMs;
	// Ready = we have a real timeline AND audio playback has started. Until then
	// (boot, or a track switch mid-download) we show a loading animation.
	bool ready = mHasRemote && mStarted && !mRemote.empty();
	if (ready) {
		int idx = remoteLineAt(mPlayheadMs);
		const RemoteLine& cur = mRemote[idx];
		uint32_t startMs = cur.startMs;
		uint32_t endMs = (idx + 1 < (int)mRemote.size())
			? mRemote[idx + 1].startMs
			: (mRemoteDurationMs > startMs ? mRemoteDurationMs : startMs + 4000);
		text = cur.text;
		uint32_t span = endMs > startMs ? endMs - startMs : 1;
		uint32_t into = mPlayheadMs > startMs ? mPlayheadMs - startMs : 0;
		prog = (float)into / (float)span;
		if (prog > 1.f) prog = 1.f;
		track = mRemoteDurationMs ? (float)mPlayheadMs / (float)mRemoteDurationMs : 0.f;
		if (track > 1.f) track = 1.f;
		hasLyric = true;
	}
	pthread_mutex_unlock(&mMutex);

	Palette pal = paletteFor(skin);
	if (hasAccent) {
		pal.primary = Color((accentRgb >> 16) & 0xff, (accentRgb >> 8) & 0xff, accentRgb & 0xff);
	}

	Surface s(52, 16, Color(0, 0, 0));

	if (!ready) {
		drawLoading(s, pal, animMs);
	} else {
		Cell cells[96];
		int totalW = 0;
		int n = layoutRow(text.c_str(), cells, 96, totalW);

		FrameCtx f;
		f.pal = &pal;
		f.cells = cells;
		f.n = n;
		f.totalW = totalW;
		f.prog = prog;
		f.track = track;
		f.animMs = animMs;
		f.playing = playing;
		f.hasLyric = hasLyric;

		if (mode == MODE_SKYLINE) paintSkyline(s, f);
		else if (mode == MODE_SPOTLIGHT) paintSpotlight(s, f);
		else if (mode == MODE_CASCADE) paintCascade(s, f);
		else paintTicker(s, f);
	}

	std::vector<uint8_t> data;
	s.extractRGB(data);
	sendLedData(data);
}

// Loading animation while waiting for a track (boot / switching): a breathing
// spectrum + three pulsing dots. No placeholder text.
void LyricsPage::drawLoading(Surface& s, const Palette& pal, float animMs) {
	// Low breathing spectrum along the very bottom two rows.
	float kick = 0.5f + 0.5f * sinf(animMs * 0.005f);
	for (int b = 0; b < SKYLINE_BARS; ++b) {
		int x = 1 + b * 3;
		int lv = skylineBarLevel(b, animMs, true, kick, 2);
		for (int i = 0; i < lv; ++i) {
			s.setPixel(x, 15 - i, pal.secondary);
			s.setPixel(x + 1, 15 - i, pal.secondary);
		}
	}
	// "加载中" centered near the top, breathing — a real loading hint.
	float breathe = 0.5f + 0.5f * sinf(animMs * 0.006f);
	int inten = int((0.35f + 0.65f * breathe) * 255.f);
	const uint32_t chars[3] = { 0x52A0, 0x8F7D, 0x4E2D };  // 加 载 中
	const int tx = 8;
	for (int k = 0; k < 3; ++k) {
		const CjkGlyph* g = cjkGlyph(chars[k]);
		if (!g) continue;
		for (int row = 0; row < 12; ++row)
			for (int col = 0; col < 12; ++col)
				if (g->rows[row] & (1 << (11 - col))) {
					int px = tx + k * 12 + col;
					if (px >= 0 && px < 52) s.setPixel(px, 1 + row, scaled(pal.primary, inten));
				}
	}
}

// ---- clock + remote timeline -----------------------------------------------

int LyricsPage::remoteLineAt(uint32_t ms) const {
	int idx = 0;
	for (int i = 0; i < (int)mRemote.size(); ++i) {
		if (mRemote[i].startMs <= ms) idx = i; else break;
	}
	return idx;
}

void LyricsPage::tick() {
	pthread_mutex_lock(&mMutex);
	mAnimMs += (uint32_t)getTickIntervalMs();
	if (mHasRemote && mPlaying && mStarted) mPlayheadMs += (uint32_t)getTickIntervalMs();
	pthread_mutex_unlock(&mMutex);
}

void LyricsPage::loadRemoteLyrics(const std::string& body) {
	std::vector<RemoteLine> lines;
	uint32_t durationMs = 0;
	size_t i = 0;
	const size_t n = body.size();
	while (i < n) {
		size_t eol = body.find('\n', i);
		if (eol == std::string::npos) eol = n;
		std::string line = body.substr(i, eol - i);
		i = eol + 1;
		if (!line.empty() && line[line.size() - 1] == '\r') line.erase(line.size() - 1);
		if (line.empty()) continue;
		size_t tab = line.find('\t');
		if (tab == std::string::npos) continue;
		std::string key = line.substr(0, tab);
		std::string val = line.substr(tab + 1);
		if (key == "DUR") {
			durationMs = (uint32_t)strtoul(val.c_str(), NULL, 10);
		} else {
			RemoteLine rl;
			rl.startMs = (uint32_t)strtoul(key.c_str(), NULL, 10);
			rl.text = val;
			lines.push_back(rl);
		}
	}
	if (lines.empty()) return;
	pthread_mutex_lock(&mMutex);
	mRemote.swap(lines);
	mRemoteDurationMs = durationMs;
	mPlayheadMs = 0;
	mHasRemote = true;
	mStarted = false;
	pthread_mutex_unlock(&mMutex);
}

void LyricsPage::startPlayback() {
	pthread_mutex_lock(&mMutex);
	mStarted = true;
	mPlaying = true;
	mPlayheadMs = 0;
	pthread_mutex_unlock(&mMutex);
}

// ---- control state ---------------------------------------------------------

void LyricsPage::setMode(int mode) {
	pthread_mutex_lock(&mMutex);
	if (mode >= 0 && mode < MODE_COUNT) mMode = mode;
	pthread_mutex_unlock(&mMutex);
}
void LyricsPage::setSkin(int skin) {
	pthread_mutex_lock(&mMutex);
	if (skin >= 0 && skin < SKIN_COUNT) mSkin = skin;
	pthread_mutex_unlock(&mMutex);
}
void LyricsPage::setAccent(uint32_t rgb, bool has) {
	pthread_mutex_lock(&mMutex);
	mAccentRgb = rgb;
	mHasAccent = has;
	pthread_mutex_unlock(&mMutex);
}
void LyricsPage::setPlaying(bool playing) {
	pthread_mutex_lock(&mMutex);
	mPlaying = playing;
	pthread_mutex_unlock(&mMutex);
}

bool LyricsPage::togglePlay() {
	pthread_mutex_lock(&mMutex);
	mPlaying = !mPlaying;
	bool p = mPlaying;
	pthread_mutex_unlock(&mMutex);
	return p;
}
int LyricsPage::cycleSkin() {
	pthread_mutex_lock(&mMutex);
	mSkin = (mSkin + 1) % SKIN_COUNT;
	int v = mSkin;
	pthread_mutex_unlock(&mMutex);
	return v;
}
int LyricsPage::cycleMode() {
	pthread_mutex_lock(&mMutex);
	mMode = (mMode + 1) % MODE_COUNT;
	int v = mMode;
	pthread_mutex_unlock(&mMutex);
	return v;
}

void LyricsPage::nextLine() {
	pthread_mutex_lock(&mMutex);
	if (mHasRemote && !mRemote.empty()) {
		int idx = remoteLineAt(mPlayheadMs);
		if (idx + 1 < (int)mRemote.size()) mPlayheadMs = mRemote[idx + 1].startMs;
	}
	pthread_mutex_unlock(&mMutex);
}
void LyricsPage::prevLine() {
	pthread_mutex_lock(&mMutex);
	if (mHasRemote && !mRemote.empty()) {
		int idx = remoteLineAt(mPlayheadMs);
		int target = idx > 0 ? idx - 1 : 0;
		mPlayheadMs = mRemote[target].startMs;
	}
	pthread_mutex_unlock(&mMutex);
}

int LyricsPage::getSkin() const {
	pthread_mutex_lock(&mMutex);
	int v = mSkin;
	pthread_mutex_unlock(&mMutex);
	return v;
}
int LyricsPage::getMode() const {
	pthread_mutex_lock(&mMutex);
	int v = mMode;
	pthread_mutex_unlock(&mMutex);
	return v;
}
bool LyricsPage::getPlaying() const {
	pthread_mutex_lock(&mMutex);
	bool v = mPlaying;
	pthread_mutex_unlock(&mMutex);
	return v;
}
uint32_t LyricsPage::getPlayheadMs() const {
	pthread_mutex_lock(&mMutex);
	uint32_t v = mHasRemote ? mPlayheadMs : 0;
	pthread_mutex_unlock(&mMutex);
	return v;
}
void LyricsPage::seekTo(uint32_t ms) {
	pthread_mutex_lock(&mMutex);
	mPlayheadMs = ms;
	pthread_mutex_unlock(&mMutex);
}

bool LyricsPage::onKeyEvent(int /*keyCode*/, int /*keyStatus*/) {
	return true;
}
