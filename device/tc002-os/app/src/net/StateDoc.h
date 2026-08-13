#ifndef NET_STATEDOC_H_
#define NET_STATEDOC_H_

#include <stdint.h>

#include <string>
#include <vector>

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
 *
 * Parsing is total: any line it does not recognise is skipped rather than
 * failing the document. A firmware that refuses to parse a response it half
 * understands would be bricked by one forward-compatible field added on the
 * service side.
 */
class StateDoc {
 public:
  enum Kind { kChannel, kMusic, kGame, kSettings };

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

  StateDoc();

  /** Returns false only when the document carried no usable `seq`. */
  bool parse(const std::string& body);

  int seq() const { return mSeq; }
  bool pinned() const { return mPinned; }
  /** True while the console is watching; the device streams frames only then. */
  bool mirror() const { return mMirror; }
  const std::string& focus() const { return mFocus; }
  const std::vector<Item>& items() const { return mItems; }

  /** Index of `focus` in items(), or -1. */
  int focusIndex() const;

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
  std::string mFocus;
  std::vector<Item> mItems;
  SettingsRequest mSettings;
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
