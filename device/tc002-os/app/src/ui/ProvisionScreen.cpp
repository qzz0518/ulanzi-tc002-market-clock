#include "ui/ProvisionScreen.h"

#include "core/Ease.h"
#include "core/Text.h"

namespace tcos {

namespace {

const int kRailY = kPanelHeight - 1;
const int kTextY = 2;
// The clip window every page is laid out in: one pixel of margin each side, so
// 50 px of the 52. Every width assertion in the host check is against this.
const int kClipX = 1;
const int kClipW = kPanelWidth - 2;

const Color kLabel(214, 244, 255);
const Color kValue(120, 255, 170);
const Color kCode(255, 206, 92);
const Color kAlarm(255, 118, 96);
const Color kRailDim(28, 46, 40);
const Color kRailAlarm(90, 26, 22);

// UTF-8 hex escapes, as everywhere else in this firmware: the toolchain's
// source charset is not something to rely on for a string that has to survive a
// cross-compile into a device with one font table.
const char* kWordProvision = "\xE9\x85\x8D\xE7\xBD\x91";                                  // 配网
const char* kWordNoBluetooth =
    "\xE8\x93\x9D\xE7\x89\x99\xE6\x9C\xAA\xE5\x90\xAF\xE5\x8A\xA8";                       // 蓝牙未启动
const char* kWordScanning = "\xE6\x89\xAB\xE6\x8F\x8F\xE4\xB8\xAD";                       // 扫描中
const char* kWordConnecting = "\xE8\xBF\x9E\xE6\x8E\xA5\xE4\xB8\xAD";                     // 连接中
const char* kWordConnected = "\xE5\xB7\xB2\xE8\xBF\x9E\xE6\x8E\xA5";                      // 已连接
const char* kWordBadPsk = "\xE5\xAF\x86\xE7\xA0\x81\xE9\x94\x99\xE8\xAF\xAF";             // 密码错误
const char* kWordNoAp =
    "\xE6\x89\xBE\xE4\xB8\x8D\xE5\x88\xB0\xE7\xBD\x91\xE7\xBB\x9C";                       // 找不到网络
const char* kWordNoLease = "\xE6\xB2\xA1\xE6\x9C\x89\xE5\x9C\xB0\xE5\x9D\x80";            // 没有地址
const char* kWordFailed = "\xE8\xBF\x9E\xE6\x8E\xA5\xE5\xA4\xB1\xE8\xB4\xA5";             // 连接失败
const char* kWordUnlocked = "\xE6\x9C\xAA\xE8\xA7\xA3\xE9\x94\x81";                       // 未解锁

void plot(Surface& out, int x, int y, const Color& c) {
  if (x < 0 || y < 0 || x >= out.getWidth() || y >= out.getHeight()) return;
  out.setPixel(x, y, c);
}

Color toneColor(ProvisionScreen::Tone tone) {
  switch (tone) {
    case ProvisionScreen::kToneValue: return kValue;
    case ProvisionScreen::kToneCode: return kCode;
    case ProvisionScreen::kToneAlarm: return kAlarm;
    case ProvisionScreen::kToneLabel:
    default: return kLabel;
  }
}

void push(std::vector<ProvisionScreen::Page>* pages, const char* text,
          ProvisionScreen::Tone tone) {
  if (text == 0 || text[0] == '\0') return;
  ProvisionScreen::Page page;
  page.text = text;
  page.tone = tone;
  pages->push_back(page);
}

void push(std::vector<ProvisionScreen::Page>* pages, const std::string& text,
          ProvisionScreen::Tone tone) {
  if (text.empty()) return;
  ProvisionScreen::Page page;
  page.text = text;
  page.tone = tone;
  pages->push_back(page);
}

const char* failureWord(ProvisionScreen::Failure failure) {
  switch (failure) {
    case ProvisionScreen::kFailBadPsk: return kWordBadPsk;
    case ProvisionScreen::kFailNoAp: return kWordNoAp;
    case ProvisionScreen::kFailDhcp: return kWordNoLease;
    case ProvisionScreen::kFailOther: return kWordFailed;
    case ProvisionScreen::kFailNone:
    default: return kWordFailed;
  }
}

}  // namespace

ProvisionScreen::Stage ProvisionScreen::stageFor(const Inputs& in) {
  // The guard first. A device that is inert by design must say so before it
  // offers a code, not after the user has typed a password into a console that
  // was never going to be listened to.
  if (in.guardLocked || in.bleBlocked) return kGuardLocked;
  // THE HONESTY RULE. Every stage below this line prints a name or a code, and
  // both are claims about what is on the air. Only the controller's own
  // acknowledgement of LE Set Advertise Enable gets past here.
  if (!in.bleAdvertising) return kRadioDown;
  if (in.online) return kOnline;
  if (in.joining) return kJoining;
  if (in.scanning) return kAuthorised;
  if (in.failed) return kFailed;
  if (in.centralConnected && !in.authorised) return kLinkUp;
  return kAdvertising;
}

ProvisionScreen::Failure ProvisionScreen::failureFor(const char* err) {
  if (err == 0 || err[0] == '\0') return kFailNone;
  const std::string code(err);
  if (code == "bad-psk") return kFailBadPsk;
  if (code == "no-ap") return kFailNoAp;
  if (code == "dhcp") return kFailDhcp;
  // Anything else is a real failure with a cause this panel cannot name.
  // Printing one of the three above anyway would send the user to fix the wrong
  // thing, which is the whole reason the classifier exists.
  return kFailOther;
}

std::vector<ProvisionScreen::Page> ProvisionScreen::pagesFor(const State& state) {
  std::vector<Page> pages;
  switch (state.stage) {
    case kRadioDown:
      push(&pages, kWordProvision, kToneLabel);
      push(&pages, kWordNoBluetooth, kToneAlarm);
      // The hotspot page only appears HERE. When BLE is on the air it is three
      // pages of noise on a device that shows one item at a time; when it is
      // not, it is the only way in and has to be said.
      push(&pages, state.portal, kToneValue);
      break;

    case kGuardLocked:
      push(&pages, kWordProvision, kToneLabel);
      // Said up front, before a code is offered. The guard refusing after the
      // user has typed a password is one wasted round trip too many now that
      // the panel has room to say it first.
      push(&pages, kWordUnlocked, kToneAlarm);
      break;

    case kAdvertising:
    case kLinkUp:
      push(&pages, kWordProvision, kToneLabel);
      push(&pages, state.name, kToneValue);
      push(&pages, state.code, kToneCode);
      break;

    case kAuthorised:
      push(&pages, kWordScanning, kToneLabel);
      break;

    case kJoining:
      push(&pages, kWordConnecting, kToneLabel);
      // The SSID, so "you picked the wrong network" is visible on the device
      // rather than only in a browser on the other side of the room.
      push(&pages, state.ssid, kToneValue);
      break;

    case kOnline:
      push(&pages, kWordConnected, kToneLabel);
      push(&pages, state.ip, kToneValue);
      break;

    case kFailed:
      push(&pages, failureWord(state.failure), kToneAlarm);
      // Still advertising: a failure ends an attempt, never the session. The
      // user's next act is to retype, and the console is still connected.
      push(&pages, state.name, kToneValue);
      push(&pages, state.code, kToneCode);
      break;
  }
  if (pages.empty()) push(&pages, kWordProvision, kToneLabel);
  return pages;
}

int ProvisionScreen::dwellMsFor(const std::string& text) {
  const int cycle = text::marqueeCycleMs(text::measure(text.c_str()), kClipW);
  return cycle > kMinDwellMs ? cycle : kMinDwellMs;
}

bool ProvisionScreen::autoAdvances(Stage stage) {
  // kLinkUp parks. The instant somebody connects is the instant the code is the
  // answer to the user's question, and a code that scrolls away while they are
  // typing it is the same as no code at all. The knob still moves.
  return stage != kLinkUp;
}

ProvisionScreen::ProvisionScreen() : mIndex(0), mPageShownMs(0), mEnteredMs(0) {}

void ProvisionScreen::setState(const State& state, int nowMs) {
  const std::vector<Page> pages = pagesFor(state);
  bool same = pages.size() == mPages.size();
  for (size_t i = 0; same && i < pages.size(); ++i) {
    if (pages[i].text != mPages[i].text || pages[i].tone != mPages[i].tone) same = false;
  }
  const Stage previous = mState.stage;
  mState = state;
  if (!same) {
    mPages = pages;
    // A changed page set restarts the carousel, because the index no longer
    // points at what it used to.
    if (mIndex >= static_cast<int>(mPages.size())) mIndex = 0;
    mPageShownMs = nowMs;
  }

  // Parking is a STAGE transition, not a page-set change, and that distinction
  // is the bug this line exists to prevent: kLinkUp shows exactly the same three
  // pages as kAdvertising, so a set comparison alone would never notice somebody
  // connecting — and the code would carry on scrolling away while they typed it.
  if (state.stage == kLinkUp && previous != kLinkUp && mPages.size() >= 3) {
    mIndex = static_cast<int>(mPages.size()) - 1;
    mPageShownMs = nowMs;
  }
}

void ProvisionScreen::onEnter(int nowMs) {
  mEnteredMs = nowMs;
  mPageShownMs = nowMs;
  if (mState.stage == kLinkUp && mPages.size() >= 3) {
    mIndex = static_cast<int>(mPages.size()) - 1;
  } else {
    mIndex = 0;
  }
}

bool ProvisionScreen::onInput(Input input, int nowMs) {
  if (mPages.empty()) return false;
  if (input == kInputTurnCw || input == kInputTurnCcw) {
    const int n = static_cast<int>(mPages.size());
    mIndex = (mIndex + (input == kInputTurnCw ? 1 : n - 1)) % n;
    mPageShownMs = nowMs;
    return true;
  }
  if (input == kInputPress) {
    // Nothing to activate — provisioning is driven from the phone — but a press
    // must never look like a dead panel, so it re-shows the current page from
    // the top of its marquee.
    mPageShownMs = nowMs;
    return true;
  }
  return false;  // hold bubbles to the Shell, which pops back to the launcher
}

void ProvisionScreen::advanceIfDue(int nowMs) {
  if (mPages.size() < 2) return;
  if (!autoAdvances(mState.stage)) return;
  const int dwell = dwellMsFor(mPages[static_cast<size_t>(mIndex)].text);
  if (nowMs - mPageShownMs < dwell) return;
  mIndex = (mIndex + 1) % static_cast<int>(mPages.size());
  mPageShownMs = nowMs;
}

void ProvisionScreen::render(Surface& out, int nowMs) {
  out.clear(Color(0, 0, 0));
  if (mPages.empty()) mPages = pagesFor(mState);
  advanceIfDue(nowMs);

  const Page& page = mPages[static_cast<size_t>(mIndex)];
  const int elapsed = nowMs - mPageShownMs;
  const int width = text::measure(page.text.c_str());
  const int x = width <= kClipW ? kClipX + (kClipW - width) / 2
                                : kClipX + text::marqueeOffset(width, kClipW, elapsed);
  // A page fades in over 160 ms so a swap reads as a swap rather than as a
  // glitch; the marquee origin is unaffected, so the two never fight.
  const float in = ease::outQuad(ease::progress(nowMs, mPageShownMs, 160));
  const Color base = toneColor(page.tone);
  const Color color(static_cast<unsigned char>(base.r * in),
                    static_cast<unsigned char>(base.g * in),
                    static_cast<unsigned char>(base.b * in));
  text::draw(out, page.text.c_str(), x, kTextY, color, kClipX, kClipW);

  renderRail(out, nowMs);
}

void ProvisionScreen::renderRail(Surface& out, int nowMs) const {
  switch (mState.stage) {
    case kAuthorised:
    case kJoining: {
      // A sweeping lit pixel. The one signal that separates "working on it" from
      // "stopped", on a screen whose text does not change for tens of seconds.
      for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, kRailDim);
      const int period = 1400;
      const int t = ((nowMs - mEnteredMs) % period + period) % period;
      const int cursor = (t * (kPanelWidth - 1)) / period;
      plot(out, cursor, kRailY, kValue);
      return;
    }
    case kOnline:
      for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, kValue);
      return;
    case kRadioDown:
    case kFailed:
    case kGuardLocked: {
      // One lit pixel in the middle, in the alarm colour: something is wrong and
      // the carousel is the explanation.
      for (int x = 0; x < kPanelWidth; ++x) plot(out, x, kRailY, kRailAlarm);
      plot(out, kPanelWidth / 2, kRailY, kAlarm);
      return;
    }
    default:
      break;
  }
  const int n = static_cast<int>(mPages.size());
  if (n <= 1) return;
  const int span = n * 2 - 1;
  const int x0 = (kPanelWidth - span) / 2;
  for (int i = 0; i < n; ++i) {
    plot(out, x0 + i * 2, kRailY, i == mIndex ? kValue : kRailDim);
  }
}

bool ProvisionScreen::isAnimating(int nowMs) const {
  (void)nowMs;
  return true;  // the rail sweeps, pages marquee, and the carousel advances
}

}  // namespace tcos
