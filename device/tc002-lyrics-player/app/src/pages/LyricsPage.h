#ifndef PAGES_LYRICSPAGE_H_
#define PAGES_LYRICSPAGE_H_

#include <stdint.h>
#include <string>
#include <vector>
#include <pthread.h>
#include "pages/PageBase.h"
#include "utils/Surface.h"
#include "visual/Palette.h"

using lyricsvisual::Palette;

// The main page. Renders scrolling, karaoke-highlighted lyric lines on the
// 52x16 matrix in one of four display modes (ticker / skyline / spotlight /
// cascade), ported from the web preview so device and web read as one system.
//
// Two lyric sources: a built-in CJK demo (before anything is selected / when the
// LAN fetch fails) and a real timeline pulled from the Pixel Studio service. The
// remote timeline and the control fields are written from the fetch/poll thread,
// so everything they touch is guarded by mMutex.
class LyricsPage : public PageBase {
public:
	explicit LyricsPage(const std::string& name);
	virtual ~LyricsPage();

	virtual void draw() override;
	virtual void onEnter() override;
	virtual void onExit() override;
	virtual bool onKeyEvent(int keyCode, int keyStatus) override;

	void tick();
	// 33fps，与网页同屏推给官方固件的帧率基线一致。60ms 曾经欠帧：聚光模式逐像素
	// 扫字（一句 4 秒、文字 200px 就要 50fps），升降模式进出场要在 0.14 的时间窗里
	// 走完 18 像素（约 32fps），两者在 16.7fps 下都是跳着走的。走带和天际不受影响
	// ——它们的文字按 12 像素整格跳、频谱按 8fps 量化，本来就饱和了。
	// mPlayheadMs 也按这个间隔累加，改这里等于同时改了本地补帧的时基。
	int getTickIntervalMs() const { return 30; }

	// Control state, set by lyricsLogic from the polled /state.
	void setMode(int mode);
	void setSkin(int skin);
	void setAccent(uint32_t rgb, bool has);
	void setPlaying(bool playing);

	// Local key actions (return the resulting value so lyricsLogic can /report).
	bool togglePlay();     // returns the new playing state
	void nextLine();
	void prevLine();
	int cycleSkin();       // returns the new skin id
	int cycleMode();       // returns the new mode id

	int getSkin() const;
	int getMode() const;
	bool getPlaying() const;
	uint32_t getPlayheadMs() const;  // remote playback position, 0 in demo mode
	void seekTo(uint32_t ms);        // jump the lyric clock (paired with an audio seek)

	// Called off the UI thread once the LAN fetch completes.
	void loadRemoteLyrics(const std::string& body);  // "DUR\t<ms>\n<startMs>\t<text>\n"...
	void startPlayback();                            // audio began: run the lyric clock
	void setFetching(bool fetching);                 // a track download is in flight

private:
	int remoteLineAt(uint32_t ms) const;             // index whose startMs<=ms (mMutex held)

	// One decoded display cell. CJK = 12px wide (cjkGlyph), Latin = 6px (latinGlyph).
	struct Cell { uint32_t cp; int width; bool cjk; int startX; };
	// Decode UTF-8 into cells, fill startX offsets, return count + total width.
	int layoutRow(const char* text, Cell* cells, int maxCells, int& totalWidth) const;
	// Blit one glyph's lit columns at (gx,y) in a solid color, clipped to view.
	void blitGlyph(Surface& s, const Cell& cell, int gx, int y, const Color& c,
	               int viewX, int viewW) const;
	int scrollOffsetFor(int totalWidth, float lyricProgress, int mode) const;

	// Per-mode painters. `prog` is the in-line lyric progress, `track` the
	// whole-track progress, both 0..1.
	// One frame's state: snapshotted under the lock, then rendered without it.
	struct FrameCtx {
		const Palette* pal;
		const Cell* cells;
		int n;
		int totalW;
		float prog;    // in-line lyric progress 0..1
		float track;   // whole-track progress 0..1
		float animMs;  // free-running animation clock
		bool playing;
		bool hasLyric;
	};
	void paintTicker(Surface&, const FrameCtx&);
	void paintSkyline(Surface&, const FrameCtx&);
	void paintSpotlight(Surface&, const FrameCtx&);
	void paintCascade(Surface&, const FrameCtx&);
	void cueRow(Surface&, const Palette&, int y, float progress, int trailPx);
	void drawLoading(Surface&, const Palette&, float animMs);  // a track is downloading
	void drawIdle(Surface&, const Palette&, float animMs);     // no track selected yet

	// Remote timeline.
	struct RemoteLine { uint32_t startMs; std::string text; };
	std::vector<RemoteLine> mRemote;
	uint32_t mRemoteDurationMs;
	uint32_t mPlayheadMs;
	bool mHasRemote;
	bool mFetching;
	bool mStarted;                                   // false until audio playback starts

	// Demo fallback.
	uint32_t mLineElapsedMs;
	int mLineIndex;

	// Control state.
	bool mPlaying;
	int mSkin;
	int mMode;                                       // 0 ticker,1 skyline,2 spotlight,3 cascade
	uint32_t mAccentRgb;
	bool mHasAccent;
	uint32_t mAnimMs;                                // free-running clock for animations

	mutable pthread_mutex_t mMutex;
};

#endif  // PAGES_LYRICSPAGE_H_
