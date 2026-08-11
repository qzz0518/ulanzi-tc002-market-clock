#ifndef UI_CHANNELRINGSCREEN_H_
#define UI_CHANNELRINGSCREEN_H_

#include <string>
#include <vector>

#include "core/RingModel.h"
#include "net/FrameBundle.h"
#include "ui/Screen.h"

namespace tcos {

/**
 * The channels, one per page, each page BEING its channel.
 *
 * This sits one level below the root ring, in the same place the games ring
 * does — channels are content, not destinations, and putting ten of them on the
 * root ring buried the four things the device actually does.
 *
 * The difference from every other ring here: a page carries no icon and no
 * label. A channel is a picture the service already composed; drawing a badge
 * and a name in front of it would be describing something the user is looking
 * at. The name appears only while the frames are still downloading, because a
 * blank panel is the one thing worse than a redundant label.
 *
 * Only the settled channel is fetched. Prefetching neighbours would mean three
 * bundles of up to ~300 KB resident to show one, on a device whose whole free
 * heap is measured in tens of megabytes and whose radio is also carrying the
 * long poll.
 */
class ChannelRingScreen : public Screen {
 public:
  struct Entry {
    std::string appName;
    std::string label;
  };

  enum Status { kLoading, kReady, kFailed, kOffline };

  ChannelRingScreen();

  /** Replaces the ring. Keeps the selected channel selected when it survives. */
  void setEntries(const std::vector<Entry>& entries, int nowMs);
  int count() const { return static_cast<int>(mEntries.size()); }
  bool empty() const { return mEntries.empty(); }

  const std::string& currentApp() const;
  const std::string& currentLabel() const;

  /** Moves to the named channel if present. Used by the console's pin. */
  bool selectApp(const std::string& appName, int nowMs);

  /**
   * True once since the settled channel last changed — the caller uses it to
   * ask the link for that channel's frames. Reading it clears it, so the
   * request happens once per move rather than once per frame.
   */
  bool takeSelectionChanged();

  /** Hands over frames. Ignored unless they belong to the settled channel. */
  void adoptFrames(FrameBundle& bundle, const std::string& appName, int nowMs);

  void setStatus(Status status, int nowMs);
  Status status() const { return mStatus; }
  bool paused() const { return mPaused; }

  void onEnter(int nowMs);
  void render(Surface& out, int nowMs);
  bool onInput(Input input, int nowMs);
  bool isAnimating(int nowMs) const;

 private:
  void renderPage(Surface& out, int nowMs) const;
  void blitShifted(Surface& out, const Surface& src, int dx) const;

  std::vector<Entry> mEntries;
  RingModel mRing;
  FrameBundle mBundle;
  std::string mBundleApp;   // which channel mBundle belongs to
  Status mStatus;
  int mStartedMs;           // playback origin for the current channel
  int mSettledMs;           // when the current channel was landed on
  int mPausedAtMs;
  bool mPaused;
  bool mSelectionChanged;

  // The page being slid away from. A channel's pixels come from a download, so
  // the outgoing page cannot be re-rendered mid-transition the way an icon card
  // can — it has to be kept.
  Surface mBody;
  Surface mOutgoing;
  bool mHasOutgoing;
};

}  // namespace tcos

#endif  // UI_CHANNELRINGSCREEN_H_
