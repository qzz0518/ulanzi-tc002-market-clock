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

 private:
  int mSeq;
  bool mPinned;
  bool mMirror;
  std::string mFocus;
  std::vector<Item> mItems;
};

}  // namespace tcos

#endif  // NET_STATEDOC_H_
