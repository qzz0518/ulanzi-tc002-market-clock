#ifndef UI_MUSICSCREEN_H_
#define UI_MUSICSCREEN_H_

#include <stdint.h>

#include <string>
#include <vector>

#include "core/LyricTiming.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * Now playing, and the transport for it.
 *
 * The lyric surface is NOT this firmware's own take on the sideloaded lyrics
 * player's — it is the same renderer, driven from a different source. The two
 * firmwares are mutually exclusive (ADR 0004) but the same user, same song and
 * same panel cross between them, and the console offers exactly one 主题设置
 * panel for both; a screen that merely resembled the other one would make that
 * panel a lie. So the four 显示形式 (ticker / skyline / spotlight / cascade),
 * the four 像素配色 and the accent override come from the lyrics player's own
 * visual/LyricModes.h and visual/Palette.h via visual/LyricVisuals.h, and the
 * painters here are ports of LyricsPage's, geometry and rounding included.
 *
 * That parity is about GEOMETRY AND COLOUR, and since ADR 0008 it is no longer
 * about timing. This screen walks the per-glyph table the service sends on
 * `lyricw`; the sideloaded player asks for the unversioned
 * /api/music/device/now and still sweeps its lines evenly. Neither is broken —
 * see the note in render() — and the two firmwares are mutually exclusive, so
 * nobody is looking at both panels at once.
 *
 * What this screen owns on top of that surface, because the reference has no
 * opinion about any of it: the three distinct empty states, the optimistic
 * transport flip, the locally advanced playhead, the press flash, and the
 * title/artist rotation for a track whose lyrics never arrived.
 *
 * Controls are chosen around what is free. The knob has no list to scroll here,
 * so it becomes previous/next; the middle button toggles play; hold still means
 * back. The side buttons are deliberately NOT taken over — volume is the one
 * control a user reaches for while music is playing, and a music screen that
 * stole it to mean "next track" would be exactly backwards.
 */
class MusicScreen : public Screen {
 public:
  enum Action { kNone, kToggle, kNext, kPrevious };

  /**
   * Wire ids for 显示形式 and 像素配色.
   *
   * The integers cross the link, not the names: these orders are the index into
   * LYRIC_MODES / LYRIC_SKINS in src/control-api.ts, the same mapping
   * logic/lyricsLogic.cc applies for the sideloaded player, and the same order
   * as visual/Palette.h's SkinId. Renumbering any one of the three silently
   * repaints the panel in a colour the console is not showing.
   */
  enum Mode {
    kModeTicker = 0,     // 走带
    kModeSkyline = 1,    // 天际
    kModeSpotlight = 2,  // 聚光
    kModeCascade = 3,    // 升降
    kModeCount = 4
  };
  enum Skin {
    kSkinSignal = 0,     // 信号绿
    kSkinTape = 1,       // 磁带橙
    kSkinBlueprint = 2,  // 蓝晒
    kSkinArcade = 3,     // 街机红
    kSkinCount = 4
  };

  MusicScreen();

  /**
   * `positionMs` is true as of `stampMs`; the screen advances it locally rather
   * than waiting for the next document, which is what makes the playhead move
   * at 25 fps over a link that updates a few times a minute.
   *
   * `lyricStartMs` / `lyricEndMs` are the current lyric line's window in track
   * time. Every mode's geometry, colouring and beat is a function of progress
   * WITHIN the line, not of the track, so without this window there is nothing
   * to animate: `pos` and `dur` describe the song, and one resolved lyric string
   * has neither a start nor an end. They are optional so a service that does not
   * send them yet still renders — see lineProgress() for what happens then — but
   * an untimed line only ever sweeps once, which is not the same screen.
   *
   * `lyricEndMs` is when the line stopped being SUNG; `lyricUntilMs` is when the
   * next line takes over, or -1 when the two coincide and the line is therefore
   * not held. `cells` is one entry per glyph of `lyric`, when the source really
   * carries word timings — with it the highlight advances at the rate the words
   * were sung instead of spreading the line evenly across its window.
   *
   * ALL THREE DEFAULT TO ABSENT, and absent has to keep meaning exactly what it
   * meant before they existed: a service older than this build sends none of
   * them, and every mode must then render byte for byte the frame it always did.
   * That is the compatibility direction that actually ships, since ZOS is
   * flashed by hand while the service updates itself.
   */
  void setNowPlaying(bool present, const std::string& track, const std::string& artist,
                     const std::string& lyric, bool playing, int positionMs,
                     int durationMs, int stampMs, int lyricStartMs = -1,
                     int lyricEndMs = -1, int lyricUntilMs = -1,
                     const LyricCell* cells = 0, int cellCount = 0);

  /**
   * The console's 主题设置, applied unconditionally on every document.
   *
   * A theme is a setting, not a reading: it has one writer, no external source
   * that can go stale, and it outlives every track — so unlike the now-playing
   * block it is never expired and never gated on the link being live. Out of
   * range ids are ignored rather than clamped, matching LyricsPage::setMode /
   * setSkin, so a document from a newer service cannot blank the screen.
   * `accentRgb` replaces the palette's primary tier ONLY; the skin keeps the
   * other three, which is what makes an accent a focus colour and not a repaint.
   */
  void setTheme(int mode, int skin, uint32_t accentRgb, bool hasAccent);

  /**
   * What the console link is doing, so the empty state can say which emptiness
   * it is.
   *
   * Without this the screen renders the same "未播放" for three unrelated
   * situations: the service says nothing is playing, the device cannot reach the
   * service, and the device was never told where the service lives. The third is
   * the normal state of a freshly FLASHED unit — /tmp/zos-host is written by the
   * sideload script and a cold boot has no /tmp — and it is the one where
   * "未播放" is an outright lie that sends the user hunting the music feature
   * instead of the address. Every other screen either has no link (games) or
   * shows its own status (the channel ring); this was the one place a dead link
   * was indistinguishable from a quiet one.
   *
   * Defaults to configured+online, so a caller that never sets it behaves
   * exactly as before.
   */
  void setLink(bool configured, bool online);

  /** True when the link is up but nothing is playing, or no provider is set. */
  bool idle() const { return !mPresent; }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

  /** The transport command the user asked for, or kNone. Reading clears it. */
  Action takeAction();

  // How long the title holds before the artist takes the row, when there is no
  // lyric to show instead.
  static const int kRotateMs = 3200;

 private:
  int playheadMs(int nowMs) const;
  float lineProgress(int nowMs) const;
  /**
   * Where the singer is on the row being drawn, given how many glyphs it laid
   * out.
   *
   * `glyphCount` rather than a member because the row is not always the lyric:
   * it is also the title/artist rotation and the 播放中 / 已暂停 fallback, and
   * those are laid out per frame. A cell table is used only when it has exactly
   * one entry per glyph of THIS row — a table one cell out of step lights the
   * wrong character for the rest of the song and is invisible on a screenshot.
   *
   * `sweepProgress` is what to fall back to when there is no usable table: the
   * line window's own scalar, or the title/artist rotation's, which the caller
   * already has and this cannot recover.
   */
  LyricCursor lyricCursor(int nowMs, int glyphCount, bool hasLyric,
                          float sweepProgress) const;
  /** True when this row has a per-glyph table that matches it exactly. */
  bool timedLine(int glyphCount, bool hasLyric) const;

  bool mPresent;
  bool mLinkConfigured;
  bool mLinkOnline;
  bool mPlaying;
  std::string mTrack;
  std::string mArtist;
  std::string mLyric;
  int mPositionMs;
  int mDurationMs;
  int mStampMs;
  int mLyricStartMs;
  int mLyricEndMs;
  // -1 for "not held", which is the ordinary case and also what an older service
  // looks like. See StateDoc::lyricUntilMs: the absence is the message.
  int mLyricUntilMs;
  LyricCellTable mLyricCells;
  int mEnteredMs;
  int mLyricChangedMs;
  int mFlashMs;
  Action mAction;
  // The console's 主题设置. Defaults match sDeviceState's in src/control-api.ts
  // (spotlight / signal / no accent) so the panel is already correct before the
  // first document arrives — including on a cold boot with no link at all.
  int mMode;
  int mSkin;
  uint32_t mAccentRgb;
  bool mHasAccent;
  // Optimistic transport state: the panel flips the moment the button is
  // pressed rather than a round trip later, because a play button that takes
  // 300 ms to look pressed reads as a dropped input.
  int mOptimisticUntilMs;
  bool mOptimisticPlaying;
};

}  // namespace tcos

#endif  // UI_MUSICSCREEN_H_
