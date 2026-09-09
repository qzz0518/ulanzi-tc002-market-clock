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

// The same trick for the VIBE block, which annotates an AGENT by id: `vibes`
// and `vibem` are collected while the document is walked and applied afterwards,
// so neither depends on its `vibea` having been seen first. The service emits
// them in that order; it never agreed to keep doing so, and the whole reason it
// repeats the id on every record is to free this parser from line order.
struct VibeRecord {
  std::string id;
  bool isMetric;  // false = the stale flag, which carries no metric
  StateDoc::VibeMetric metric;

  VibeRecord() : isMetric(false) {}
};

// Either half of the value cell's time-share. Clamped here as well as in the
// hub for the reason the caps above are: the service is not the only thing that
// can put bytes on this socket, and a cycle of a few milliseconds would strobe
// the one cell a person reads a number out of.
int clampVibeDwell(int ms) {
  if (ms < StateDoc::kMinVibeDwellMs) return StateDoc::kMinVibeDwellMs;
  if (ms > StateDoc::kMaxVibeDwellMs) return StateDoc::kMaxVibeDwellMs;
  return ms;
}

// The service already clamps these to 0..999, so this is belt and braces — but
// the page has three digit cells and a 14 px meter, and neither should be able
// to be widened by a document.
int clampVibeNumber(const std::string& text) {
  int value = atoi(text.c_str());
  if (value < 0) return 0;
  if (value > 999) return 999;
  return value;
}

bool kindFromName(const std::string& name, StateDoc::Kind* out) {
  if (name == "channel") { *out = StateDoc::kChannel; return true; }
  if (name == "music") { *out = StateDoc::kMusic; return true; }
  if (name == "game") { *out = StateDoc::kGame; return true; }
  if (name == "settings") { *out = StateDoc::kSettings; return true; }
  if (name == "vibe") { *out = StateDoc::kVibe; return true; }
  return false;
}

}  // namespace

SettingsPlan planSettings(const SettingsRequest& request, int appliedSeq,
                          int currentVolume, int currentBrightness) {
  SettingsPlan plan;
  // Nothing this device has not already acted on. The document repeats the last
  // request on every poll, so this is the common case by a wide margin.
  if (request.seq <= appliedSeq) return plan;

  // A service that names neither field is older than this firmware. Read that
  // as "both moved, at the document's sequence": it is what the wire meant
  // before the per-field keys existed, and it keeps the VALUES landing exactly
  // as they always did. Only the bar falls back to a guess below.
  const bool perField = request.volumeSeq > 0 || request.brightnessSeq > 0;
  const int volumeSeq = perField ? request.volumeSeq : request.seq;
  const int brightnessSeq = perField ? request.brightnessSeq : request.seq;

  plan.applyVolume = request.volume >= 0 && volumeSeq > appliedSeq;
  plan.applyBrightness = request.brightness >= 0 && brightnessSeq > appliedSeq;

  if (perField) {
    // The sequences say which control the user moved, so the bar is not a
    // guess. Both moving at once is a coalesced poll — two writes the device
    // read as one document — and the later one is the slider still under the
    // user's finger. See SettingsPlan for why a tie shows volume.
    if (plan.applyVolume && plan.applyBrightness) {
      plan.bar = brightnessSeq > volumeSeq ? SettingsPlan::kBrightnessBar
                                           : SettingsPlan::kVolumeBar;
    } else if (plan.applyVolume) {
      plan.bar = SettingsPlan::kVolumeBar;
    } else if (plan.applyBrightness) {
      plan.bar = SettingsPlan::kBrightnessBar;
    }
    return plan;
  }

  // Legacy service: the only thing separating the field the user moved from the
  // one riding along in every document is whether the value differs from what
  // the device is at. A request for the level already set therefore raises
  // nothing — the console loses its feedback, which is the price of not being
  // told, and is still better than showing the wrong control's bar.
  const bool volumeMoved = plan.applyVolume && request.volume != currentVolume;
  const bool brightnessMoved =
      plan.applyBrightness && request.brightness != currentBrightness;
  if (volumeMoved) plan.bar = SettingsPlan::kVolumeBar;
  else if (brightnessMoved) plan.bar = SettingsPlan::kBrightnessBar;
  return plan;
}

StateDoc::StateDoc()
    : mSeq(-1), mPinned(false), mMirror(false), mUpgradeSeq(0), mBleOpenSeq(0),
      mVibeAutoSec(0), mVibeValueDwellMs(-1), mVibeResetDwellMs(-1),
      mHasNowPlaying(false),
      mPlaying(false), mPositionMs(0), mDurationMs(0), mLyricStartMs(-1),
      mLyricEndMs(-1), mLyricUntilMs(-1), mLyricMode(kDefaultMode),
      mLyricSkin(kDefaultSkin), mAccentRgb(0), mHasAccent(false) {}

bool StateDoc::parse(const std::string& body) {
  mSeq = -1;
  mPinned = false;
  mMirror = false;
  // Cleared, so an absent key reads as "this document carries no request"
  // rather than as whatever the last one said. It costs nothing — the caller
  // gates on a RISING sequence, not on presence — but it keeps the rule this
  // parser states for the theme: a document is a whole picture.
  mBleOpenSeq = 0;
  mFocus.clear();
  mItems.clear();
  mVibe.clear();
  // Same rule: a service that stopped sending it — an older build, a rollback —
  // means knob-only, not "keep turning at whatever the last document said".
  mVibeAutoSec = 0;
  // -1, not the shipped default: "the service did not say" and "the service
  // said 3200" must stay distinguishable, or a rollback would read as a
  // deliberate setting instead of an absence.
  mVibeValueDwellMs = -1;
  mVibeResetDwellMs = -1;
  mSettings = SettingsRequest();
  mSleep = SleepRequest();
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
  mLyricUntilMs = -1;
  mLyricCells.clear();
  // Reset to the defaults rather than to "keep the last": a document is a whole
  // picture, and a service that stopped sending a theme (an older build, or a
  // rollback) must land the panel somewhere predictable instead of on whatever
  // the previous document happened to say.
  mLyricMode = kDefaultMode;
  mLyricSkin = kDefaultSkin;
  mAccentRgb = 0;
  mHasAccent = false;

  std::vector<Annotation> annotations;
  std::vector<VibeRecord> vibeRecords;
  // Held raw and decoded after the walk, because the offsets in it are relative
  // to `lyricat` and a parser that depended on `lyricat` arriving first would be
  // keying off line ORDER — the same dependency `rev`/`ttl` repeat their id to
  // avoid. The service happens to emit them in that order today; it never agreed
  // to keep doing so.
  std::string lyricTable;

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

    // SIX, not four. `vibem` is the one record with five separators, and it is
    // shaped that way because the alternative — packing four numbers into one
    // comma-separated field, the `lyricw` trick — buys nothing here: that table
    // is unbounded and this one is exactly five columns wide. Widening the split
    // only makes the arity checks below stricter (a five-field `item` now fails
    // `n == 4` instead of quietly keeping the extra column inside its label),
    // which is the direction this parser already wanted to be wrong in.
    std::string fields[6];
    const int n = splitTabs(line, fields, 6);
    if (n < 2) continue;

    if (fields[0] == "seq") {
      mSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "pinned") {
      mPinned = (fields[1] == "1");
    } else if (fields[0] == "mirror") {
      mMirror = (fields[1] == "1");
    } else if (fields[0] == "upgrade") {
      // A console-initiated install request. A CHANGE of this number arms one
      // download (HostLink::adoptDocument) and the resulting install is honoured
      // once per boot, because the updater does not clear the image it flashed
      // and a device that re-checked on its own would reinstall it every boot
      // with a frozen screen. A change rather than an increase: the hub's
      // counter is ordinary state in a Bun process and returns to 1 when the
      // service restarts.
      mUpgradeSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "bleopen") {
      // 蓝牙配网, asked for by the console. An INCREASE of this number opens the
      // same five-minute advertising window the 配网 row opens, and nothing
      // else: no reboot, no flash, so a repeat is harmless and there is no
      // /data record behind it. An increase rather than a change, because the
      // hub issues seconds-since-epoch and the only question the device has is
      // "is this newer than the one I already acted on this boot".
      mBleOpenSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "focus") {
      mFocus = fields[1];
    } else if (fields[0] == "setseq") {
      mSettings.seq = atoi(fields[1].c_str());
    } else if (fields[0] == "setvol") {
      mSettings.volume = atoi(fields[1].c_str());
    } else if (fields[0] == "setbri") {
      mSettings.brightness = atoi(fields[1].c_str());
    } else if (fields[0] == "setvolseq") {
      // Separate keys rather than a third field on `setvol`, for the same
      // reason `rev`/`ttl` are separate from `item`: a deployed parser that
      // ever grows an arity check would drop the whole line, and a level the
      // firmware silently stops applying is a very quiet failure.
      mSettings.volumeSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "setbriseq") {
      mSettings.brightnessSeq = atoi(fields[1].c_str());
    } else if (fields[0] == "sleepseq") {
      mSleep.seq = atoi(fields[1].c_str());
    } else if (fields[0] == "sleepon") {
      mSleep.on = (fields[1] == "1") ? 1 : 0;
    } else if (fields[0] == "sleepfrom") {
      mSleep.startMin = atoi(fields[1].c_str());
    } else if (fields[0] == "sleeptill") {
      mSleep.endMin = atoi(fields[1].c_str());
    } else if (fields[0] == "sleepidle") {
      // SECONDS on the wire, not ms: the value is minutes-scale, has no
      // sub-second meaning, and a short line is cheaper for an atoi parser.
      mSleep.idleSec = atoi(fields[1].c_str());
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
    } else if (fields[0] == "lyricuntil") {
      // Sent only when the line is genuinely held past its singing, so its
      // absence is the statement "these two clocks coincide" rather than a gap
      // in the document. -1 keeps that distinguishable from a zero.
      mLyricUntilMs = atoi(fields[1].c_str());
    } else if (fields[0] == "lyricw") {
      // ONE comma-separated field, not tab-separated columns: splitTabs above
      // stops after three tabs and would hand this loop a truncated table. That
      // is why the service encodes it this way — see encodeLyricCells in
      // src/music/lyric-timing.ts.
      lyricTable = fields[1];
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
    } else if (fields[0] == "vibea" && n == 4) {
      // Strict arity, like `item`: a record this parser cannot read in full is
      // an agent it would draw a mark for and no numbers, which is worse than
      // an agent that is simply absent.
      if (fields[1].empty()) continue;
      if ((int)mVibe.size() >= StateDoc::kMaxVibeAgents) continue;
      // Indexed by id, so a document that repeats one updates it rather than
      // putting the same vendor on the ring twice.
      bool known = false;
      for (size_t i = 0; i < mVibe.size(); ++i) {
        if (mVibe[i].id != fields[1]) continue;
        mVibe[i].label = fields[2];
        mVibe[i].plan = fields[3];
        known = true;
        break;
      }
      if (known) continue;
      VibeAgent agent;
      agent.id = fields[1];
      agent.label = fields[2];
      agent.plan = fields[3];
      mVibe.push_back(agent);
    } else if (fields[0] == "vibeauto" && n >= 2) {
      // The app's own page dwell, in SECONDS — a property of the screen, not of
      // any agent, so it rides the block rather than repeating on every record.
      //
      // Clamped here as well as in the hub, for the reason kMaxVibeAgents is:
      // the service is not the only thing that can put bytes on this socket, and
      // a raw `atoi` reaching `* 1000` in the UI is an int overflow. 0 stays 0
      // — it is the OFF state, not an out-of-range value to be floored up.
      const int declared = atoi(fields[1].c_str());
      if (declared <= 0) {
        mVibeAutoSec = 0;
      } else if (declared < StateDoc::kMinVibeAutoSec) {
        mVibeAutoSec = StateDoc::kMinVibeAutoSec;
      } else if (declared > StateDoc::kMaxVibeAutoSec) {
        mVibeAutoSec = StateDoc::kMaxVibeAutoSec;
      } else {
        mVibeAutoSec = declared;
      }
    } else if (fields[0] == "vibedwell" && n >= 3) {
      // How the value cell is split in time. Both halves clamped here as well as
      // in the hub, same rule as vibeauto; 0 survives only on the countdown
      // half, where it means "just the number, never the countdown".
      const int value = atoi(fields[1].c_str());
      const int reset = atoi(fields[2].c_str());
      mVibeValueDwellMs = value <= 0 ? -1 : clampVibeDwell(value);
      mVibeResetDwellMs = reset < 0 ? -1 : (reset == 0 ? 0 : clampVibeDwell(reset));
    } else if (fields[0] == "vibes" && n >= 3) {
      // Sent only when the agent IS stale, so its absence is the statement
      // "these numbers are fresh" rather than a gap in the document.
      if (fields[1].empty() || fields[2] != "1") continue;
      VibeRecord record;
      record.id = fields[1];
      record.isMetric = false;
      vibeRecords.push_back(record);
    } else if (fields[0] == "vibem" && n == 6) {
      if (fields[1].empty()) continue;
      VibeRecord record;
      record.id = fields[1];
      record.isMetric = true;
      record.metric.label = fields[2];
      record.metric.used = clampVibeNumber(fields[3]);
      record.metric.limit = clampVibeNumber(fields[4]);
      // -1 is "the vendor did not say when", and every value below it means the
      // same thing. Anything else is seconds from now.
      record.metric.resetSec = atoi(fields[5].c_str());
      if (record.metric.resetSec < -1) record.metric.resetSec = -1;
      vibeRecords.push_back(record);
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
    // Everything else — including `menu` and `vibe`, which are only counts, and
    // this parser builds both lists from the records themselves — is ignored on
    // purpose, so the service can add fields without bricking deployed firmware.
    if (end >= body.size()) break;
  }

  if (!lyricTable.empty()) {
    // A refusal leaves the table empty, which is the same shape as a track with
    // no word timings at all — so the panel sweeps the line evenly instead of
    // lighting glyphs at times nobody sang.
    if (!decodeLyricCells(lyricTable, mLyricStartMs, &mLyricCells)) mLyricCells.clear();
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

  for (size_t r = 0; r < vibeRecords.size(); ++r) {
    for (size_t i = 0; i < mVibe.size(); ++i) {
      if (mVibe[i].id != vibeRecords[r].id) continue;
      if (!vibeRecords[r].isMetric) {
        mVibe[i].stale = true;
      } else if ((int)mVibe[i].metrics.size() < StateDoc::kMaxVibeMetrics) {
        // Order is the service's starred order, which is what decides which row
        // a metric lands on, so metrics past the second are dropped rather than
        // rotated in — a page that showed rows 2 and 3 would answer a question
        // the user never starred.
        mVibe[i].metrics.push_back(vibeRecords[r].metric);
      }
      break;
    }
    // A record naming an agent this document does not carry is dropped, for the
    // same reason a rev for a departed channel is: the document is a whole
    // picture, and holding it would attach yesterday's numbers to whoever takes
    // that id next.
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
