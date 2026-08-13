#ifndef UI_CHANNELRINGSCREEN_H_
#define UI_CHANNELRINGSCREEN_H_

#include <string>
#include <vector>

#include "core/RingModel.h"
#include "net/FrameBundle.h"
#include "net/StateDoc.h"
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
    /** Fingerprint of the frames behind this channel; empty when unsupported. */
    std::string rev;
    /** How long a fetched bundle stays true, or 0 for "does not expire". */
    int ttlMs;

    Entry() : ttlMs(0) {}
  };

  enum Status { kLoading, kReady, kFailed, kOffline };

  /**
   * The channel half of a menu, in this ring's own terms.
   *
   * Only `kChannel` items: the root ring is fixed at the four things this
   * device does, and ten channels there would push the other three off the end
   * of a ring that shows one item at a time.
   *
   * A static here rather than a helper in osLogic.cc so a self-check can drive
   * the real mapping. Every field it forwards is one the ring compares against
   * what it is holding, and a field quietly dropped on the way in is a channel
   * that never refreshes again — the exact failure this file is being changed
   * to end.
   */
  static std::vector<Entry> channelEntries(const std::vector<StateDoc::Item>& items);

  ChannelRingScreen();

  /**
   * Replaces the ring. Keeps the selected channel selected when it survives —
   * but drops its frames when its REVISION moved, which is what a content edit
   * looks like from here.
   *
   * Keeping the selection was right and keeping the frames was the bug: the
   * service republishes the menu on every settings change, so this runs after
   * every edit, and until the revision existed the only observable difference
   * between "the user renamed something" and "the pixels of the channel you are
   * watching changed" was nothing at all.
   */
  void setEntries(const std::vector<Entry>& entries, int nowMs);
  int count() const { return static_cast<int>(mEntries.size()); }
  bool empty() const { return mEntries.empty(); }

  const std::string& currentApp() const;
  const std::string& currentLabel() const;
  const std::string& currentRev() const;
  int currentTtlMs() const;

  /** Moves to the named channel if present. Used by the console's pin. */
  bool selectApp(const std::string& appName, int nowMs);

  /**
   * True once since the settled channel last changed — the caller uses it to
   * ask the link for that channel's frames. Reading it clears it, so the
   * request happens once per move rather than once per frame.
   */
  bool takeSelectionChanged();

  /**
   * True once when the held frames need fetching again although the selection
   * has not moved. The caller turns this into a forced re-fetch.
   *
   * Two things ask for it. Entering the ring, because the frames held from last
   * time may be minutes old — the intent onEnter always claimed and never had,
   * since a re-select of the same channel could not reach the network. And the
   * ttl expiring, which is the only way a time-driven face can ever advance: 大字
   * 天气钟 is ten seconds of frames of a clock, nobody edits anything, and no
   * revision moves while the minute it shows recedes into the past.
   *
   * THE RATE LIMIT LIVES HERE, and it is the reason this is a `take`: the
   * deadline is pushed forward at the moment it fires, not when the frames
   * land, so a channel the service cannot serve is retried once per ttl instead
   * of on every one of the 25 ticks a second that follow.
   */
  bool takeRefreshDue(int nowMs);

  /**
   * Hands over frames. Ignored unless they belong to the settled channel.
   *
   * `rev` is what the service said it served. Stored as the revision the held
   * bundle IS, so the next menu tells us whether it still matches — comparing
   * against the revision we happened to want at request time would re-download
   * once for free whenever a save landed mid-flight.
   */
  void adoptFrames(FrameBundle& bundle, const std::string& appName,
                   const std::string& rev, int nowMs);

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
  /** Drops the held frames and asks for the settled channel's. */
  void invalidate(int nowMs);

  std::vector<Entry> mEntries;
  RingModel mRing;
  FrameBundle mBundle;
  std::string mBundleApp;   // which channel mBundle belongs to
  std::string mBundleRev;   // and which revision of it
  int mBundleAtMs;          // when it arrived, against which its ttl is measured
  Status mStatus;
  int mStartedMs;           // playback origin for the current channel
  int mSettledMs;           // when the current channel was landed on
  int mPausedAtMs;
  bool mPaused;
  bool mSelectionChanged;
  bool mForceRefresh;

  // The page being slid away from. A channel's pixels come from a download, so
  // the outgoing page cannot be re-rendered mid-transition the way an icon card
  // can — it has to be kept.
  Surface mBody;
  Surface mOutgoing;
  bool mHasOutgoing;
};

}  // namespace tcos

#endif  // UI_CHANNELRINGSCREEN_H_
