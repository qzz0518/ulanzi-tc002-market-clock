#ifndef NET_STATEDOC_H_
#define NET_STATEDOC_H_

#include <string>
#include <vector>

namespace tcos {

/**
 * Parser for the document served by GET /api/os/pull.
 *
 * The format is line-oriented `KEY\tVALUE`, chosen so this can be a split loop
 * rather than a JSON dependency on a device with ~1 MB free:
 *
 *   seq\t7
 *   pinned\t1
 *   focus\tbtc
 *   menu\t3
 *   item\tchannel\tbtc\t市场轮播
 *   item\tmusic\tmusic\t音乐
 *   item\tsettings\tsettings\t设置
 *   np\t1
 *   track\tHer Majesty
 *   artist\tThe Beatles
 *   playing\t1
 *   pos\t18400
 *   dur\t23000
 *   lyric\tHer Majesty's a pretty nice girl
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
  };

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
   * Settings the console asked for, and the sequence that makes them safe.
   *
   * The device applies a value only when `settingsSeq()` is HIGHER than the one
   * it last applied. Without that the console's old value sits in every
   * document forever and is re-applied on each poll, which makes the knob
   * useless: the volume springs back the instant the user lets go.
   */
  int settingsSeq() const { return mSettingsSeq; }
  int requestedVolume() const { return mRequestedVolume; }      // -1 when absent
  int requestedBrightness() const { return mRequestedBrightness; }

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

 private:
  int mSeq;
  bool mPinned;
  bool mMirror;
  std::string mFocus;
  std::vector<Item> mItems;
  int mSettingsSeq;
  int mRequestedVolume;
  int mRequestedBrightness;
  std::vector<Input> mInputs;
  bool mHasNowPlaying;
  bool mPlaying;
  int mPositionMs;
  int mDurationMs;
  std::string mTrack;
  std::string mArtist;
  std::string mLyric;
};

}  // namespace tcos

#endif  // NET_STATEDOC_H_
