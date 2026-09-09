#ifndef NET_STATEDOC_H_
#define NET_STATEDOC_H_

#include <stdint.h>

#include <string>
#include <vector>

#include "core/LyricTiming.h"

namespace tcos {

/**
 * The console's settings block: what it asked for, and WHEN it asked for each.
 *
 * Two per-field sequences beside the document's own, because a VALUE cannot say
 * which control the user moved. The document carries the console's last request
 * for both levels forever — deliberately, since that is what makes a coalesced
 * poll (two console writes, one document) apply both instead of losing the
 * earlier one — so a device reading only the values sees "volume 4, brightness
 * 7" whether the user just moved the volume slider, the brightness slider, or
 * nothing at all. The per-field sequences are the only thing that tells those
 * apart, and telling them apart is what decides which bar the panel raises.
 *
 * Zero means "this service does not send per-field sequences": an older build,
 * answered by treating both fields as moved at the document's own sequence,
 * which is exactly the behaviour that shipped before these keys existed.
 */
struct SettingsRequest {
  int seq;            // setseq; 0 before the console has ever written
  int volume;         // setvol, or -1 when absent
  int volumeSeq;      // setvolseq, or 0 when the service does not send one
  int brightness;     // setbri, or -1 when absent
  int brightnessSeq;  // setbriseq, or 0 when the service does not send one

  SettingsRequest()
      : seq(0), volume(-1), volumeSeq(0), brightness(-1), brightnessSeq(0) {}
};

/**
 * The console's 夜间休眠 block.
 *
 * ONE sequence for four fields, unlike the settings block above. Volume and
 * brightness needed per-field sequences because the panel has one bar and had
 * to name which control the user moved; there is no such display here, and the
 * four fields are always written together by one console form. Nobody should
 * copy the three-sequence pattern across by cargo cult.
 *
 * -1 means "the document did not name this", which is how a console that only
 * flips the switch leaves the window the knob configured. The sequence is what
 * makes the request safe to repeat: the document carries it forever, so acting
 * on presence rather than on a rising edge would overrule the device's own 设置
 * screen on every poll.
 */
struct SleepRequest {
  int seq;       // sleepseq; 0 before the console has ever written
  int on;        // sleepon: 0/1, or -1 when absent
  int startMin;  // sleepfrom, minutes since local midnight, or -1
  int endMin;    // sleeptill, or -1
  int idleSec;   // sleepidle, SECONDS, or -1

  SleepRequest() : seq(0), on(-1), startMin(-1), endMin(-1), idleSec(-1) {}
};

/**
 * What one settings document should actually do to the device.
 *
 * Split out of osLogic.cc for the same reason menuSignature was: it needs no
 * FlyThings header, it is the only thing standing between a console slider and
 * the panel, and while it lived inline it had no test — which is how a
 * volume-only change could raise the BRIGHTNESS bar for the whole life of the
 * build. The user saw the brightness screen and a volume that had, correctly,
 * moved.
 *
 * `bar` is at most one kind, because the panel has one bar. When both levels
 * move in the same document the more RECENT request wins (the higher per-field
 * sequence — the slider still under the user's finger), and a genuine tie — one
 * PUT carrying both — shows VOLUME: it is the change with no other evidence on
 * the device (brightness is visible in every lit pixel, a muted speaker is
 * not), and it is the only choice that leaves the side buttons in their default
 * mode instead of silently arming brightness for the next 1.3 s.
 */
struct SettingsPlan {
  enum Bar { kNoBar, kVolumeBar, kBrightnessBar };

  bool applyVolume;
  bool applyBrightness;
  Bar bar;

  SettingsPlan() : applyVolume(false), applyBrightness(false), bar(kNoBar) {}
};

/**
 * Decides what to apply and what to show, given the last sequence the device
 * acted on and the levels it is currently at.
 *
 * The current levels are read ONLY on the legacy path, where no per-field
 * sequence exists and "did this value move" is the only signal left. On that
 * path a console re-sending the level the device already has raises no bar at
 * all — worse feedback than the bug being fixed, but strictly better than
 * naming a control the user did not touch, and it can only happen against a
 * service older than this firmware.
 */
SettingsPlan planSettings(const SettingsRequest& request, int appliedSeq,
                          int currentVolume, int currentBrightness);

/**
 * Parser for the document served by GET /api/os/pull.
 *
 * The format is line-oriented `KEY\tVALUE`, chosen so this can be a split loop
 * rather than a JSON dependency on a device with ~1 MB free:
 *
 *   seq\t7
 *   pinned\t1
 *   focus\tbtc
 *   mode\tspotlight
 *   skin\ttape
 *   accent\tff8844
 *   menu\t3
 *   item\tchannel\tbtc\t市场轮播
 *   rev\tbtc\te90a8dc5b287
 *   ttl\tbtc\t10000
 *   item\tmusic\tmusic\t音乐
 *   item\tsettings\tsettings\t设置
 *   np\t1
 *   track\tHer Majesty
 *   artist\tThe Beatles
 *   playing\t1
 *   pos\t18400
 *   dur\t23000
 *   lyric\tHer Majesty's a pretty nice girl
 *   lyricat\t18000
 *   lyricend\t21500
 *   lyricuntil\t34800
 *   lyricw\t0,420,420,380,800,300,…
 *   vibeauto\t15
 *   vibedwell\t3200\t1600
 *   vibe\t2
 *   vibea\tclaude\tClaude\tMax 20x
 *   vibem\tclaude\tSession\t11\t100\t18000
 *   vibea\tcodex\tCodex\tPlus
 *   vibes\tcodex\t1
 *
 * Parsing is total: any line it does not recognise is skipped rather than
 * failing the document. A firmware that refuses to parse a response it half
 * understands would be bricked by one forward-compatible field added on the
 * service side.
 */
class StateDoc {
 public:
  /**
   * The document revision THIS parser implements, sent to the service as `proto`
   * in every telemetry report and gating what it sends back.
   *
   * 2 means "`lyricend` is the SUNG end, and I read `lyricuntil` and `lyricw`".
   * Builds before it sent no `proto` at all, which the service reads as 0 and
   * answers with the older encoding — `lyricend` carrying the display window —
   * because feeding a tighter end to a cascade choreography built on the wider
   * one flies the line off the panel the instant the singer stops and leaves 升降
   * blank for the whole instrumental (ADR 0008, OS_PROTO_LYRIC_WINDOW in
   * src/os-link.ts). ZOS is flashed rather than sideloaded, so the two halves
   * genuinely do move independently and that is not a hypothetical.
   *
   * Raising this number is a promise about THIS FILE and ui/MusicScreen, and
   * nothing else: bump it only once both can read what the bump asks for.
   */
  static const int kProtocol = 2;

  // Appended rather than slotted in beside kGame, where 「VIBE」 sits on the
  // ring: nothing persists these integers, but menuSignature prints them, and
  // renumbering an existing kind would make every stored signature compare
  // unequal once — a free rebuild of the channel ring for no news at all.
  enum Kind { kChannel, kMusic, kGame, kSettings, kVibe };

  struct Item {
    Kind kind;
    std::string id;
    std::string label;

    /**
     * Fingerprint of the frames behind this entry, or empty when the service
     * does not send one.
     *
     * The device fetches a channel's pixels once and holds them, and an edit
     * moves neither the id nor the label — which is why the only way to see a
     * recoloured 灯牌 was to turn the knob to another channel and back. This is
     * the field that makes an edit expressible on the wire at all.
     *
     * Empty must keep meaning "never invalidate", not "invalidate now": that is
     * the shape an older service produces, and a firmware that read an absent
     * rev as a change would re-download every channel on every poll.
     */
    std::string rev;

    /**
     * How long a fetched bundle stays true, in ms, or 0 for "does not expire".
     *
     * 大字天气钟 is ten seconds of frames of a clock, so a device that loops
     * them forever is showing a minute that has already passed — and no rev
     * moves, because nobody edited anything. Only the service knows how long
     * its own render is good for, so it says rather than making us guess.
     */
    int ttlMs;

    Item() : kind(kChannel), ttlMs(0) {}
  };

  /**
   * The device's own floor under `ttl`, below the service's own 1 s clamp.
   *
   * A refresh costs this device a whole frame bundle — up to ~900 KB over the
   * same radio that is carrying the long poll — and the service holds a
   * channel's render in a 5 s cache, so a device asking more often than that is
   * guaranteed to be handed the bytes it already has. Anything faster is a
   * download loop that cannot produce a new pixel.
   */
  static const int kMinTtlMs = 5000;

  /**
   * One quota row of one AI coding agent, already reduced to integers.
   *
   * The service does every unit conversion: percent-shaped metrics arrive as
   * used/limit out of the vendor's own ceiling, and the panel does no arithmetic
   * beyond used/limit. That is deliberate — "is this metric a percentage, a
   * dollar balance or a credit count" is the kind of question that grows a table
   * of vendor rules, and a table of vendor rules is the one thing this device
   * must never hold: it cannot be updated without a reflash.
   */
  struct VibeMetric {
    /**
     * The vendor's own row label — Session, Weekly, Credits.
     *
     * Not translated and not normalised, so what the console shows and what the
     * panel shows are the same word. The panel has room for one character of it
     * (see ui/VibeScreen), which is a layout decision and not a wire one.
     */
    std::string label;
    int used;   // 0..999; the service clamps, so three digit cells always suffice
    /**
     * The vendor's ceiling, or 0 when it named none.
     *
     * Zero is a STATE, not a missing value: a credit balance genuinely has no
     * ceiling, and a screen that divided by it would invent a percentage nobody
     * quoted. Such a row draws a bare number and no meter.
     */
    int limit;
    /**
     * Seconds until this quota resets, RELATIVE, or -1 when unknown.
     *
     * Relative because this device's wall clock may never have been synced —
     * "resets in 6 days" needs no calendar, and an absolute timestamp compared
     * against an unsynced clock would count down to a moment in the past.
     */
    int resetSec;

    VibeMetric() : used(0), limit(0), resetSec(-1) {}
  };

  /**
   * One signed-in agent, as the service last read it from that vendor.
   *
   * `stale` means the vendor refused this round and the numbers are the last
   * good ones still being held up — the panel marks it rather than hiding it,
   * because a number the user cannot see is worse than one they can distrust.
   */
  struct VibeAgent {
    std::string id;     // catalog id, also the key into visual/VibeIcons.h
    std::string label;  // the vendor's display name
    std::string plan;   // the vendor's own plan string, e.g. "Max 20x"
    bool stale;
    std::vector<VibeMetric> metrics;  // at most kMaxVibeMetrics, in starred order

    VibeAgent() : stale(false) {}
  };

  /**
   * Caps, matched to the service's MAX_VIBE_AGENTS / MAX_VIBE_METRICS.
   *
   * Enforced again here rather than trusted: the service clamps what it sends,
   * but the page has exactly two metric rows and a ring the knob has to be able
   * to get around, and neither should depend on the other end behaving.
   */
  static const int kMaxVibeAgents = 10;
  static const int kMaxVibeMetrics = 2;

  /**
   * Bounds on the VIBE page dwell, in seconds. 0 — knob only — is outside them
   * on purpose: it is a state, not a small interval to be floored up.
   *
   * The floor is the value/countdown cycle (kValueDwellMs + kResetDwellMs =
   * 4.8 s in ui/VibeScreen.h): under it a metric's reset countdown would never
   * get its turn in the cell it shares with the number, so the page would show
   * half of what it has. The ceiling is the service's own republish cadence —
   * past five minutes the numbers change more often than the page does.
   */
  static const int kMinVibeAutoSec = 5;
  static const int kMaxVibeAutoSec = 300;

  /**
   * Bounds on either half of the value cell's time-share (`vibedwell`).
   *
   * 0 for the countdown half is outside them and means "never show it" — a
   * choice, not a small interval. The floor is what a person can actually read
   * a three-digit number in; the ceiling keeps the other half coming round
   * inside a page dwell somebody would plausibly set.
   */
  static const int kMinVibeDwellMs = 500;
  static const int kMaxVibeDwellMs = 20000;

  StateDoc();

  /** Returns false only when the document carried no usable `seq`. */
  bool parse(const std::string& body);

  int seq() const { return mSeq; }
  bool pinned() const { return mPinned; }
  /** True while the console is watching; the device streams frames only then. */
  bool mirror() const { return mMirror; }
  /** Console-initiated install request; 0 when never asked. */
  int upgradeSeq() const { return mUpgradeSeq; }
  /**
   * Console-initiated 蓝牙配网 request; 0 when never asked.
   *
   * The console's wizard can only SCAN, and this device advertises only while
   * it is offline or inside the five-minute window 设置 → 配网 opens. A clock
   * that is online and working — the one whose owner is moving it to another
   * router — is therefore invisible to the chooser unless somebody walks up to
   * it. This is the console asking for that window from across the LAN.
   *
   * A RISING value is the request, never the key's presence: the document is
   * pulled and repeats what it carries on every poll, so acting on presence
   * would re-arm the window on each long poll and the panel could never leave
   * the provisioning screen. See HostLink::adoptDocument.
   */
  int bleOpenSeq() const { return mBleOpenSeq; }
  const std::string& focus() const { return mFocus; }
  const std::vector<Item>& items() const { return mItems; }

  /** Index of `focus` in items(), or -1. */
  int focusIndex() const;

  /**
   * The usage rows behind 「VIBE」, in the service's catalog order.
   *
   * Empty means "nobody is signed in on the host", which is a state the screen
   * has words for — and it is also what a service older than this firmware
   * looks like, which is the same situation from the panel's side.
   */
  const std::vector<VibeAgent>& vibe() const { return mVibe; }

  /**
   * How long 「VIBE」 holds a page before turning itself, in seconds; 0 = the
   * knob is the only thing that turns it.
   *
   * A SETTING, unlike vibe() beside it — the console is its only writer, so the
   * document simply states it on every poll and this parser does not gate it on
   * a sequence. Absence reads as 0, which is what a service predating the key
   * looks like and also exactly what it used to do.
   */
  int vibeAutoSec() const { return mVibeAutoSec; }

  /**
   * How the value cell is split between the number and the reset countdown, in
   * ms. `-1` on either means the document did not say — a service predating the
   * key — and the screen keeps its shipped default; `0` on the countdown half
   * means the user asked for the number alone.
   *
   * Milliseconds, unlike `vibeAutoSec` beside it, because these are sub-second
   * quantities: a 3.2 s dwell rounded to whole seconds is a different layout.
   */
  int vibeValueDwellMs() const { return mVibeValueDwellMs; }
  int vibeResetDwellMs() const { return mVibeResetDwellMs; }

  /**
   * Now playing, resolved to text by the service.
   *
   * `hasNowPlaying()` is false when nothing is playing OR when no music
   * provider is connected; the music screen shows the same "nothing here yet"
   * state for both, because from the panel they are the same situation.
   *
   * `positionMs` is true as of the moment the document was served. The screen
   * advances it locally — the service deliberately does not bump the sequence
   * for a moving playhead, so a poll-rate-limited progress bar is not an
   * option and would not be smooth anyway.
   */
  /**
   * Settings the console asked for, and the sequences that make them safe.
   *
   * The device applies a value only when its sequence is HIGHER than the one it
   * last applied. Without that the console's old value sits in every document
   * forever and is re-applied on each poll, which makes the knob useless: the
   * volume springs back the instant the user lets go.
   *
   * Exposed as the whole struct, with no per-field accessor beside it, because
   * reading one level without the other's sequence is exactly the mistake that
   * showed a brightness bar for a volume change. Feed it to planSettings().
   */
  const SettingsRequest& settings() const { return mSettings; }

  /**
   * 夜间休眠, as the console last asked for it.
   *
   * Feed it to applySleepRequest(), which is the only thing allowed to turn it
   * into something the panel obeys. Absent from a document leaves seq 0, which
   * can never rise above a primed sequence — so an old service and a new
   * firmware simply leave the device's own 设置 rows in charge.
   */
  const SleepRequest& sleep() const { return mSleep; }

  /**
   * Button and knob events the console pressed on the device's behalf.
   *
   * Each carries its own sequence; the device injects the ones it has not seen.
   * The service keeps only a short tail — the document is pulled, so anything
   * unread must still be in it, but a press the device missed by more than a
   * moment is one the user has already given up on.
   */
  struct Input {
    int seq;
    std::string action;  // cw ccw press hold left right
  };
  const std::vector<Input>& inputs() const { return mInputs; }

  bool hasNowPlaying() const { return mHasNowPlaying; }
  const std::string& track() const { return mTrack; }
  const std::string& artist() const { return mArtist; }
  const std::string& lyric() const { return mLyric; }
  bool playing() const { return mPlaying; }
  int positionMs() const { return mPositionMs; }
  int durationMs() const { return mDurationMs; }

  /**
   * The current lyric line's window in track time, or -1 for "not sent".
   *
   * Every display mode animates against progress within the LINE, not the
   * track, so these are what make the mode a mode. Optional on purpose: an
   * older service sends neither, and a firmware that needed them would black
   * out the music screen rather than fall back to an untimed sweep.
   */
  int lyricStartMs() const { return mLyricStartMs; }
  int lyricEndMs() const { return mLyricEndMs; }

  /**
   * When the NEXT line takes over, or -1 for "this line is not held".
   *
   * ABSENCE CARRIES MEANING and is the common case: the service emits this key
   * only when the line really does stay up past its singing, so -1 means the two
   * clocks coincide and `lyricEndMs` answers both questions. It also means an
   * older service, which is the same situation from the panel's side.
   *
   * Only the 升降 choreography may read it. Every other part of the screen —
   * colouring, focus glyph, fill bar, beat, scroll — runs on the sung clock.
   */
  int lyricUntilMs() const { return mLyricUntilMs; }

  /**
   * `lyricw` decoded: one cell per glyph of `lyric()`, in absolute track ms.
   *
   * EMPTY IS A DESIGNED STATE, not a failure. Roughly four fifths of tracks have
   * no word timings at all, and a line whose words do not rebuild its text is
   * refused service-side rather than shipped one cell out of step — so an empty
   * table means "sweep the line evenly", which is exactly what this firmware did
   * before the key existed.
   */
  const LyricCellTable& lyricCells() const { return mLyricCells; }

  /**
   * The console's 主题设置, as wire integers.
   *
   * Mapped here rather than in the screen for two reasons: it keeps string
   * compares out of the 25 fps render path, and it puts the fallback in one
   * place. An absent key AND an unrecognised value both yield the default
   * (spotlight / signal) — a document from a newer service naming a mode this
   * firmware does not have must still paint something, and "whatever was there
   * before" would leave two devices on the same account showing different
   * screens with no way to tell which one is stale.
   *
   * The integers are the index into LYRIC_MODES / LYRIC_SKINS in
   * src/control-api.ts, which is also MusicScreen::Mode / Skin and the
   * sideloaded player's Palette.h SkinId. All three orders are the same fact.
   */
  static const int kDefaultMode = 2;  // spotlight
  static const int kDefaultSkin = 0;  // signal
  int lyricMode() const { return mLyricMode; }
  int lyricSkin() const { return mLyricSkin; }
  /** Only meaningful when hasAccent(); replaces the skin's primary tier. */
  uint32_t accentRgb() const { return mAccentRgb; }
  bool hasAccent() const { return mHasAccent; }

 private:
  int mSeq;
  bool mPinned;
  bool mMirror;
  int mUpgradeSeq;
  int mBleOpenSeq;
  std::string mFocus;
  std::vector<Item> mItems;
  std::vector<VibeAgent> mVibe;
  int mVibeAutoSec;
  int mVibeValueDwellMs;
  int mVibeResetDwellMs;
  SettingsRequest mSettings;
  SleepRequest mSleep;
  std::vector<Input> mInputs;
  bool mHasNowPlaying;
  bool mPlaying;
  int mPositionMs;
  int mDurationMs;
  std::string mTrack;
  std::string mArtist;
  std::string mLyric;
  int mLyricStartMs;
  int mLyricEndMs;
  int mLyricUntilMs;
  LyricCellTable mLyricCells;
  int mLyricMode;
  int mLyricSkin;
  uint32_t mAccentRgb;
  bool mHasAccent;
};

/**
 * One line per item: everything the channel ring is rebuilt for, and nothing
 * else.
 *
 * The document's sequence bumps on things the ring does not care about — a
 * lyric line changes every few seconds — so the ring is rebuilt on this string
 * moving rather than on the sequence. Which makes what it covers load-bearing:
 * keyed on kind/id/label alone it answered "nothing changed" to every content
 * edit the user has ever made, because an edit moves neither an id nor a label.
 * The revision and the ttl are in here for exactly that reason.
 *
 * Lives beside the parser rather than in osLogic.cc so the host self-check can
 * assert it: this comparison is the only thing standing between a saved edit
 * and the panel, and it had no test at all while it was a static helper inside
 * a translation unit that needs FlyThings headers to compile.
 */
std::string menuSignature(const std::vector<StateDoc::Item>& items);

}  // namespace tcos

#endif  // NET_STATEDOC_H_
