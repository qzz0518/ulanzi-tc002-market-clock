#include "net/StateDoc.h"

#include <stdlib.h>

namespace tcos {

namespace {

// Splits on '\t'. Returns the number of fields written, capped at `maxFields`;
// the final field keeps any remaining tabs, which cannot happen because the
// service strips separators out of user-authored labels, but costs nothing to
// be safe about.
int splitTabs(const std::string& line, std::string* out, int maxFields) {
  int n = 0;
  size_t start = 0;
  while (n < maxFields - 1) {
    const size_t tab = line.find('\t', start);
    if (tab == std::string::npos) break;
    out[n++] = line.substr(start, tab - start);
    start = tab + 1;
  }
  if (n < maxFields) out[n++] = line.substr(start);
  return n;
}

bool kindFromName(const std::string& name, StateDoc::Kind* out) {
  if (name == "channel") { *out = StateDoc::kChannel; return true; }
  if (name == "music") { *out = StateDoc::kMusic; return true; }
  if (name == "game") { *out = StateDoc::kGame; return true; }
  if (name == "settings") { *out = StateDoc::kSettings; return true; }
  return false;
}

}  // namespace

StateDoc::StateDoc()
    : mSeq(-1), mPinned(false), mMirror(false), mHasNowPlaying(false),
      mPlaying(false), mPositionMs(0), mDurationMs(0) {}

bool StateDoc::parse(const std::string& body) {
  mSeq = -1;
  mPinned = false;
  mMirror = false;
  mFocus.clear();
  mItems.clear();
  mHasNowPlaying = false;
  mPlaying = false;
  mPositionMs = 0;
  mDurationMs = 0;
  mTrack.clear();
  mArtist.clear();
  mLyric.clear();

  size_t start = 0;
  while (start <= body.size()) {
    size_t end = body.find('\n', start);
    if (end == std::string::npos) end = body.size();
    const std::string line = body.substr(start, end - start);
    start = end + 1;
    if (line.empty()) {
      if (end >= body.size()) break;
      continue;
    }

    std::string fields[4];
    const int n = splitTabs(line, fields, 4);
    if (n < 2) continue;

    if (fields[0] == "seq") {
      mSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "pinned") {
      mPinned = (fields[1] == "1");
    } else if (fields[0] == "mirror") {
      mMirror = (fields[1] == "1");
    } else if (fields[0] == "focus") {
      mFocus = fields[1];
    } else if (fields[0] == "np") {
      mHasNowPlaying = (fields[1] == "1");
    } else if (fields[0] == "track") {
      mTrack = fields[1];
    } else if (fields[0] == "artist") {
      mArtist = fields[1];
    } else if (fields[0] == "playing") {
      mPlaying = (fields[1] == "1");
    } else if (fields[0] == "pos") {
      mPositionMs = atoi(fields[1].c_str());
    } else if (fields[0] == "dur") {
      mDurationMs = atoi(fields[1].c_str());
    } else if (fields[0] == "lyric") {
      mLyric = fields[1];
    } else if (fields[0] == "item" && n == 4) {
      Item item;
      // An unknown kind is skipped rather than guessed: rendering a settings
      // icon for something the service called "video" would be a lie the user
      // has no way to see through.
      if (!kindFromName(fields[1], &item.kind)) continue;
      item.id = fields[2];
      item.label = fields[3];
      mItems.push_back(item);
    }
    // Everything else — including `menu`, which is only a hint — is ignored on
    // purpose, so the service can add fields without bricking deployed firmware.
    if (end >= body.size()) break;
  }
  return mSeq >= 0;
}

int StateDoc::focusIndex() const {
  if (mFocus.empty()) return -1;
  for (size_t i = 0; i < mItems.size(); ++i) {
    if (mItems[i].id == mFocus) return static_cast<int>(i);
  }
  return -1;
}

}  // namespace tcos
