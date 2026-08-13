#include "net/StateDoc.h"

#include <stdio.h>
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

// The wire order for 显示形式 and 像素配色. These arrays ARE the protocol: index
// 0..3 is what MusicScreen::Mode / Skin, LYRIC_MODES / LYRIC_SKINS in
// src/control-api.ts and the sideloaded player's Palette.h all agree on.
// Returns the fallback for anything else, so a mode this build has never heard
// of paints spotlight rather than nothing.
int indexOfName(const std::string& name, const char* const* table, int count, int fallback) {
  for (int i = 0; i < count; ++i) {
    if (name == table[i]) return i;
  }
  return fallback;
}

const char* const kModeNames[4] = {"ticker", "skyline", "spotlight", "cascade"};
const char* const kSkinNames[4] = {"signal", "tape", "blueprint", "arcade"};

// Exactly six hex digits, or nothing. A half-parsed colour is worse than none:
// strtoul would happily read "ff" out of "ff88zz" and repaint the panel a
// colour nobody chose, and the same rule already governs malformed inputs.
bool parseAccent(const std::string& text, uint32_t* out) {
  if (text.size() != 6) return false;
  uint32_t value = 0;
  for (size_t i = 0; i < 6; ++i) {
    const char c = text[i];
    int digit;
    if (c >= '0' && c <= '9') digit = c - '0';
    else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
    else return false;
    value = (value << 4) | (uint32_t)digit;
  }
  *out = value;
  return true;
}

// `rev` and `ttl` annotate an item by id. They are collected while the document
// is walked and applied afterwards rather than folded into "the item we just
// appended": the service emits them directly after their item today, but it
// repeats the id precisely so this parser does not have to depend on an
// ordering it never agreed to. A dropped rev is a channel that stops refreshing
// for good, which is too quiet a failure to key on line order.
struct Annotation {
  std::string id;
  std::string rev;
  int ttlMs;  // -1 when this record carries no ttl
};

bool kindFromName(const std::string& name, StateDoc::Kind* out) {
  if (name == "channel") { *out = StateDoc::kChannel; return true; }
  if (name == "music") { *out = StateDoc::kMusic; return true; }
  if (name == "game") { *out = StateDoc::kGame; return true; }
  if (name == "settings") { *out = StateDoc::kSettings; return true; }
  return false;
}

}  // namespace

StateDoc::StateDoc()
    : mSeq(-1), mPinned(false), mMirror(false), mSettingsSeq(0),
      mRequestedVolume(-1), mRequestedBrightness(-1), mHasNowPlaying(false),
      mPlaying(false), mPositionMs(0), mDurationMs(0), mLyricStartMs(-1),
      mLyricEndMs(-1), mLyricMode(kDefaultMode), mLyricSkin(kDefaultSkin),
      mAccentRgb(0), mHasAccent(false) {}

bool StateDoc::parse(const std::string& body) {
  mSeq = -1;
  mPinned = false;
  mMirror = false;
  mFocus.clear();
  mItems.clear();
  mSettingsSeq = 0;
  mRequestedVolume = -1;
  mRequestedBrightness = -1;
  mInputs.clear();
  mHasNowPlaying = false;
  mPlaying = false;
  mPositionMs = 0;
  mDurationMs = 0;
  mTrack.clear();
  mArtist.clear();
  mLyric.clear();
  mLyricStartMs = -1;
  mLyricEndMs = -1;
  // Reset to the defaults rather than to "keep the last": a document is a whole
  // picture, and a service that stopped sending a theme (an older build, or a
  // rollback) must land the panel somewhere predictable instead of on whatever
  // the previous document happened to say.
  mLyricMode = kDefaultMode;
  mLyricSkin = kDefaultSkin;
  mAccentRgb = 0;
  mHasAccent = false;

  std::vector<Annotation> annotations;

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
    } else if (fields[0] == "setseq") {
      mSettingsSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "setvol") {
      mRequestedVolume = atoi(fields[1].c_str());
    } else if (fields[0] == "setbri") {
      mRequestedBrightness = atoi(fields[1].c_str());
    } else if (fields[0] == "input" && n >= 3) {
      Input event;
      event.seq = atoi(fields[1].c_str());
      event.action = fields[2];
      // A malformed event is skipped rather than injected as some default: a
      // guessed button press is worse than a dropped one.
      if (event.seq > 0 && !event.action.empty()) mInputs.push_back(event);
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
    } else if (fields[0] == "lyricat") {
      mLyricStartMs = atoi(fields[1].c_str());
    } else if (fields[0] == "lyricend") {
      mLyricEndMs = atoi(fields[1].c_str());
    } else if (fields[0] == "mode") {
      mLyricMode = indexOfName(fields[1], kModeNames, 4, kDefaultMode);
    } else if (fields[0] == "skin") {
      mLyricSkin = indexOfName(fields[1], kSkinNames, 4, kDefaultSkin);
    } else if (fields[0] == "accent") {
      mHasAccent = parseAccent(fields[1], &mAccentRgb);
      if (!mHasAccent) mAccentRgb = 0;
    } else if (fields[0] == "item" && n == 4) {
      Item item;
      // An unknown kind is skipped rather than guessed: rendering a settings
      // icon for something the service called "video" would be a lie the user
      // has no way to see through.
      if (!kindFromName(fields[1], &item.kind)) continue;
      item.id = fields[2];
      item.label = fields[3];
      mItems.push_back(item);
    } else if (fields[0] == "rev" && n >= 3) {
      Annotation note;
      note.id = fields[1];
      note.rev = fields[2];
      note.ttlMs = -1;
      if (!note.id.empty() && !note.rev.empty()) annotations.push_back(note);
    } else if (fields[0] == "ttl" && n >= 3) {
      const int declared = atoi(fields[2].c_str());
      // A non-positive ttl is dropped rather than clamped: it means the service
      // said something this build cannot make sense of, and "does not expire"
      // is the safe reading. Anything positive is floored, because the cost of
      // a refresh is ours and only we know it.
      if (!fields[1].empty() && declared > 0) {
        Annotation note;
        note.id = fields[1];
        note.ttlMs = declared < StateDoc::kMinTtlMs ? StateDoc::kMinTtlMs : declared;
        annotations.push_back(note);
      }
    }
    // Everything else — including `menu`, which is only a hint — is ignored on
    // purpose, so the service can add fields without bricking deployed firmware.
    if (end >= body.size()) break;
  }

  for (size_t a = 0; a < annotations.size(); ++a) {
    for (size_t i = 0; i < mItems.size(); ++i) {
      if (mItems[i].id != annotations[a].id) continue;
      if (!annotations[a].rev.empty()) mItems[i].rev = annotations[a].rev;
      if (annotations[a].ttlMs >= 0) mItems[i].ttlMs = annotations[a].ttlMs;
      break;
    }
    // An annotation naming an item that is not in this document is dropped. It
    // cannot be held for the next one: the document is a whole picture, and a
    // rev kept from a menu that no longer contains its channel would invalidate
    // whatever took that id later.
  }
  return mSeq >= 0;
}

std::string menuSignature(const std::vector<StateDoc::Item>& items) {
  std::string out;
  for (size_t i = 0; i < items.size(); ++i) {
    char numbers[24];
    snprintf(numbers, sizeof(numbers), "%d", (int)items[i].kind);
    out += numbers;
    out += '\x1f';
    out += items[i].id;
    out += '\x1f';
    out += items[i].label;
    out += '\x1f';
    out += items[i].rev;
    out += '\x1f';
    snprintf(numbers, sizeof(numbers), "%d", items[i].ttlMs);
    out += numbers;
    out += '\x1e';
  }
  return out;
}

int StateDoc::focusIndex() const {
  if (mFocus.empty()) return -1;
  for (size_t i = 0; i < mItems.size(); ++i) {
    if (mItems[i].id == mFocus) return static_cast<int>(i);
  }
  return -1;
}

}  // namespace tcos
