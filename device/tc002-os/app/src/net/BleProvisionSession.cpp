#include "net/BleProvisionSession.h"

namespace tcos {

namespace {

// The error vocabulary, as static strings so they can be compared by pointer and
// held without allocation. Every one of them appears on the wire verbatim.
const char* kErrNone = "";
const char* kErrNoCode = "no-code";
// The join would re-point this device at a console it is not on. Distinct from
// `no-code` because the console reacts to them differently: this one raises the
// code prompt (with the reason), `no-code` only says the last six digits were
// wrong. Sharing one code would put a "wrong code" error on a field the user
// has not been shown yet.
const char* kErrHostCode = "host-code";
const char* kErrLockedOut = "locked-out";
const char* kErrLinkLocked = "link-locked";
const char* kErrBadPsk = "bad-psk";
const char* kErrNoAp = "no-ap";
const char* kErrDhcp = "dhcp";
// `frame` and `doc` are two different failures and used to share one code, which
// cost the console its only chance to react. `frame` is layer 1 — a chunk was
// lost, an orphan continuation arrived, a message overflowed — and it IS
// recoverable: the next FIRST chunk resynchronises, so the console ignores it.
// `doc` is layer 2 — the reassembled document did not parse — and is permanent:
// resending the identical bytes fails identically, so the console must fail fast
// instead of waiting out its reply timeout and reporting 时钟没有应答, which
// would be a lie about a device that answered immediately and said no.
const char* kErrFrame = "frame";
const char* kErrDoc = "doc";
const char* kErrCmd = "cmd";
const char* kErrArg = "arg";
const char* kErrScan = "scan-empty";
const char* kErrBusy = "busy";

// ASCII case-insensitive equality. DNS is case-insensitive and so is the
// authority half of a URL, so `Studio.local` and `studio.local` are the same
// console; comparing them byte-for-byte would demand a pairing code for a join
// that changes nothing, which is the exact friction this rule exists to remove.
// Deliberately ASCII-only: an IDN arrives already punycoded.
bool equalFold(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    char x = a[i];
    char y = b[i];
    if (x >= 'A' && x <= 'Z') x = static_cast<char>(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = static_cast<char>(y - 'A' + 'a');
    if (x != y) return false;
  }
  return true;
}

}  // namespace

BleProvisionSession::BleProvisionSession()
    : mConnected(false),
      mAuthorised(false),
      mAttempts(0),
      mLockedAtMs(-1),
      mPhase(kPhaseIdle),
      mPhaseBeforeScan(kPhaseIdle),
      mError(kErrNone),
      mLocked(false),
      mJoinStartedMs(0),
      mSawJoining(false),
      mSawAssociated(false),
      mSawHandshake(false),
      mSawCompleted(false),
      mRequest(kRequestNone) {}

void BleProvisionSession::configure(const std::string& name, const std::string& build,
                                    const std::string& mac) {
  mName = name;
  mBuild = build;
  mMac = mac;
}

void BleProvisionSession::noteConsole(const std::string& url) { mConsoleUrl = url; }

bool BleProvisionSession::hostIsTakeover(const std::string& host,
                                         const std::string& consoleUrl) {
  // No field at all: the join leaves the address alone.
  if (host.empty()) return false;
  // A field the validator refuses is dropped rather than acted on (see the join
  // branch), so it cannot re-point anything and must not cost a code — a
  // console bug would otherwise turn into a pairing prompt nobody can explain.
  if (!ble::hostIsSafe(host)) return false;
  // Nothing adopted: there is no console to take over. This is first-run setup,
  // and it is the case the vendor's firmware makes seamless.
  if (consoleUrl.empty()) return false;
  // Both sides through the one normaliser, so `host`, `host:port` and
  // `http://host:port` are compared as the single URL they all name.
  return !equalFold(ble::consoleUrl(host), ble::consoleUrl(consoleUrl));
}

void BleProvisionSession::beginAdvertising(uint32_t seed, int nowMs) {
  // A running lockout keeps its code. Rolling a new one on every reconnect would
  // turn "five wrong tries and wait a minute" into "five wrong tries per
  // reconnect", which is not a limit.
  if (lockoutRemainingMs(nowMs) > 0) return;
  mCode = ble::codeFromSeed(seed);
  mAttempts = 0;
  mAuthorised = false;
}

void BleProvisionSession::onConnect(int nowMs) {
  (void)nowMs;
  mConnected = true;
  // Authorisation is per connection: a central that drops the link has to prove
  // it can read the panel again.
  mAuthorised = false;
  mLastStateDoc.clear();
}

void BleProvisionSession::onDisconnect(int nowMs) {
  (void)nowMs;
  mConnected = false;
  mAuthorised = false;
  mOutbound.clear();
  mAudit.clear();
  mLastStateDoc.clear();
  // A join already handed to the policy is NOT cancelled here. The link dropping
  // the moment the clock joins WiFi is the expected shape of success on this
  // radio, not a reason to stop.
}

int BleProvisionSession::lockoutRemainingMs(int nowMs) const {
  if (mLockedAtMs < 0) return 0;
  const int elapsed = nowMs - mLockedAtMs;
  if (elapsed >= kLockoutMs || elapsed < 0) return 0;
  return kLockoutMs - elapsed;
}

std::string BleProvisionSession::takeConsoleHost() {
  const std::string host = mAdoptedHost;
  mAdoptedHost.clear();
  return host;
}

const char* BleProvisionSession::phase() const {
  switch (mPhase) {
    case kPhaseLocked: return "locked";
    case kPhaseScanning: return "scanning";
    case kPhaseJoining: return "joining";
    case kPhaseOnline: return "online";
    case kPhaseFailed: return "failed";
    case kPhaseIdle:
    default: return "idle";
  }
}

void BleProvisionSession::queue(const std::string& message) {
  if (static_cast<int>(mOutbound.size()) >= kMaxOutbound) return;
  mOutbound.push_back(message);
}

void BleProvisionSession::audit(const char* cmd, const char* outcome) {
  if (mAudit.size() >= 16) return;
  std::string line = "cmd=";
  line += cmd;
  line += " rc=";
  line += outcome;
  line += " auth=";
  line += mAuthorised ? "1" : "0";
  // The literal, always. Grep a pulled log for `psk=` and this must be the only
  // hit — the same contract ProvisionLog's own header states.
  line += " psk=redacted";
  mAudit.push_back(line);
}

bool BleProvisionSession::takeAudit(std::string* fields) {
  if (mAudit.empty()) return false;
  fields->assign(mAudit.front());
  mAudit.erase(mAudit.begin());
  return true;
}

bool BleProvisionSession::takeOutbound(std::string* message) {
  if (mOutbound.empty()) return false;
  message->assign(mOutbound.front());
  mOutbound.erase(mOutbound.begin());
  return true;
}

BleProvisionSession::Request BleProvisionSession::takeRequest(std::string* ssid,
                                                              std::string* psk) {
  const Request request = mRequest;
  mRequest = kRequestNone;
  ssid->assign(mRequestSsid);
  psk->assign(mRequestPsk);
  mRequestSsid.clear();
  // Overwrite before releasing: a std::string that merely shrinks keeps the
  // bytes in its buffer, and this object outlives every provisioning session.
  for (size_t i = 0; i < mRequestPsk.size(); ++i) mRequestPsk[i] = '\0';
  mRequestPsk.clear();
  return request;
}

void BleProvisionSession::emitState() {
  // No `retry` here on purpose: a countdown changes every second, and a state
  // document that changes every second defeats the de-duplication below and
  // turns a 6 Hz poll into a notification storm. The lockout replies build their
  // own document with the live countdown, which is the only place it is asked
  // for.
  const std::string doc = ble::buildState(phase(), mTargetSsid, mIp, mError, -1);
  if (doc == mLastStateDoc) return;
  mLastStateDoc = doc;
  queue(doc);
}

void BleProvisionSession::setPhase(Phase phase, const char* error) {
  mPhase = phase;
  mError = error;
}

bool BleProvisionSession::requireTakeoverCode(int nowMs) {
  if (mAuthorised) return true;
  const int remaining = lockoutRemainingMs(nowMs);
  if (remaining > 0) {
    queue(ble::buildState(phase(), mTargetSsid, mIp, kErrLockedOut,
                          (remaining + 999) / 1000));
    return false;
  }
  queue(ble::buildState(phase(), mTargetSsid, mIp, kErrHostCode, -1));
  return false;
}

bool BleProvisionSession::requireUnlocked() {
  if (!mLocked) return true;
  // Refused HERE, before the radio is asked for anything. The guard file is the
  // difference between a sideloaded device that keeps the link adb rides on and
  // one that reassociates and needs a physical power cycle.
  queue(ble::buildState("locked", mTargetSsid, mIp, kErrLinkLocked, -1));
  return false;
}

void BleProvisionSession::checkCode(const std::string& supplied, int nowMs) {
  if (lockoutRemainingMs(nowMs) > 0) {
    queue(ble::buildState(phase(), mTargetSsid, mIp, kErrLockedOut,
                          (lockoutRemainingMs(nowMs) + 999) / 1000));
    return;
  }
  if (mLockedAtMs >= 0) {
    // The lockout has expired; start the count over.
    mLockedAtMs = -1;
    mAttempts = 0;
  }
  if (!mCode.empty() && supplied == mCode) {
    mAuthorised = true;
    mAttempts = 0;
    // Force the next emitState through: the console asked a question and must
    // get an answer even when nothing about the link changed.
    mLastStateDoc.clear();
    emitState();
    return;
  }
  ++mAttempts;
  if (mAttempts >= kMaxCodeAttempts) {
    mLockedAtMs = nowMs;
    queue(ble::buildState(phase(), mTargetSsid, mIp, kErrLockedOut, kLockoutMs / 1000));
    return;
  }
  queue(ble::buildState(phase(), mTargetSsid, mIp, kErrNoCode, -1));
}

void BleProvisionSession::onFrameError(const char* why, int nowMs) {
  (void)why;
  (void)nowMs;
  queue(ble::buildErr(kErrFrame));
}

void BleProvisionSession::onMessage(const std::string& body, int nowMs) {
  ble::Message message;
  const char* why = "";
  if (!message.parse(body, &why)) {
    // Rejected whole. Half a document is not a smaller document, it is a
    // different one, and this is the input a stranger controls.
    queue(ble::buildErr(kErrDoc));
    audit("?", why);
    return;
  }

  if (message.has("code")) checkCode(message.get("code"), nowMs);

  const std::string cmd = message.get("cmd");
  if (cmd.empty()) {
    queue(ble::buildErr(kErrCmd));
    audit("?", "no-cmd");
    return;
  }

  if (cmd == "hello") {
    queue(ble::buildHello(mName, mBuild, mMac));
    mLastStateDoc.clear();
    if (mLocked) setPhase(kPhaseLocked, kErrLinkLocked);
    audit("hello", "ok");
    // No `no-code` here any more. hello used to answer with it unconditionally,
    // which told the console to put a six-digit field in front of a user who,
    // on every path but a console takeover, is never going to be asked for one.
    // The device now says what it is doing and waits to be asked for something.
    emitState();
    return;
  }

  if (cmd == "code") {
    // checkCode already ran above and answered. A `cmd code` with no code field
    // is a malformed request rather than a silent no-op.
    if (!message.has("code")) queue(ble::buildErr(kErrArg));
    audit("code", mAuthorised ? "ok" : "reject");
    return;
  }

  if (cmd == "abort") {
    mRequest = kRequestNone;
    mRequestSsid.clear();
    mRequestHost.clear();
    for (size_t i = 0; i < mRequestPsk.size(); ++i) mRequestPsk[i] = '\0';
    mRequestPsk.clear();
    if (mPhase == kPhaseScanning || mPhase == kPhaseJoining || mPhase == kPhaseFailed) {
      setPhase(mLocked ? kPhaseLocked : kPhaseIdle, kErrNone);
    }
    mLastStateDoc.clear();
    emitState();
    audit("abort", "ok");
    return;
  }

  if (cmd == "scan") {
    // No code. A scan lists SSIDs that are already being broadcast to everyone
    // in the building; there is nothing here a code could protect. The guard
    // file still applies, because a sweep does touch the radio adb rides on.
    if (!requireUnlocked()) {
      audit("scan", "link-locked");
      return;
    }
    if (mPhase == kPhaseScanning) {
      queue(ble::buildErr(kErrBusy));
      audit("scan", "busy");
      return;
    }
    mPhaseBeforeScan = mPhase == kPhaseFailed ? kPhaseIdle : mPhase;
    setPhase(kPhaseScanning, kErrNone);
    mRequest = kRequestScan;
    emitState();
    audit("scan", "ok");
    return;
  }

  if (cmd == "join") {
    if (!requireUnlocked()) {
      audit("join", "link-locked");
      return;
    }
    const std::string ssid = message.get("ssid");
    const std::string psk = message.get("psk");
    // Validated before it is stored, let alone before it reaches the control
    // socket. See ble::ssidIsSafe for the quote-and-backslash reason. This
    // survives the code no longer being demanded here: it is the hardening the
    // stock firmware appears to lack, not the ceremony this change removed.
    if (!ble::ssidIsSafe(ssid) || !ble::pskIsSafe(psk)) {
      queue(ble::buildErr(kErrArg));
      audit("join", "arg");
      return;
    }
    // Optional console address. Invalid means IGNORED, not rejected — the join
    // must not fail over a field the firmware can live without.
    const std::string host = message.get("host");
    // THE ONE THING THE CODE STILL GUARDS. Everything above this line is within
    // a stock Ulanzi join's power and is answered without a code; re-pointing an
    // already-adopted console is not, and is refused until presence is proven.
    // Checked here, after validation and before anything is stored, so a refusal
    // leaves the session exactly as it found it — the console re-sends the
    // identical join once the user has typed the digits.
    if (hostIsTakeover(host, mConsoleUrl) && !requireTakeoverCode(nowMs)) {
      audit("join", "host-code");
      return;
    }
    if (!host.empty() && ble::hostIsSafe(host)) {
      mRequestHost = host;
    } else {
      if (!host.empty()) audit("host", "arg");
      mRequestHost.clear();
    }
    mRequestSsid = ssid;
    mRequestPsk = psk;
    mRequest = kRequestJoin;
    mTargetSsid = ssid;
    mIp.clear();
    mJoinStartedMs = nowMs;
    mSawJoining = false;
    mSawAssociated = false;
    mSawHandshake = false;
    mSawCompleted = false;
    setPhase(kPhaseJoining, kErrNone);
    mLastStateDoc.clear();
    emitState();
    audit("join", "ok");
    return;
  }

  queue(ble::buildErr(kErrCmd));
  audit("?", "unknown");
}

void BleProvisionSession::observeWpaState(const std::string& state) {
  if (state == "COMPLETED") {
    mSawCompleted = true;
    mSawAssociated = true;
  } else if (state == "4WAY_HANDSHAKE" || state == "GROUP_HANDSHAKE") {
    mSawHandshake = true;
    mSawAssociated = true;
  } else if (state == "ASSOCIATED") {
    mSawAssociated = true;
  }
}

const char* BleProvisionSession::classifyFailure(bool sawAssociated, bool sawHandshake,
                                                 bool sawCompleted, bool hasAddress) {
  if (sawCompleted) return hasAddress ? kErrNone : kErrDhcp;
  if (sawHandshake || sawAssociated) return kErrBadPsk;
  return kErrNoAp;
}

void BleProvisionSession::noteLink(const Link& link, int nowMs) {
  mLocked = link.locked;
  mIp = link.ip;

  if (mPhase == kPhaseJoining) {
    observeWpaState(link.wpaState);
    if (link.joining) mSawJoining = true;
    if (link.online) {
      setPhase(kPhaseOnline, kErrNone);
      if (!link.ssid.empty()) mTargetSsid = link.ssid;
      if (!mRequestHost.empty()) {
        mAdoptedHost = mRequestHost;
        mRequestHost.clear();
      }
      emitState();
      return;
    }
    const bool budgetSpent = (nowMs - mJoinStartedMs) >= kJoinBudgetMs;
    // "Not joining any more" is the policy having given up; the budget is the
    // backstop for the state it never gives up on (kObtainingIp has no exit —
    // see WifiPolicy::kDhcpTimeoutMs).
    //
    // mSawJoining is what makes "any more" true. Before the policy has ever
    // been seen associating, `!link.joining` means "not yet", not "gave up" —
    // and the caller cannot always guarantee the ordering, because the policy
    // sits in kStandby while a BLE console is connected. Without this latch a
    // single early sample classifies the attempt as no-ap before the radio has
    // been touched. kJoinBudgetMs still ends an attempt that never associates.
    if ((!link.joining && mSawJoining) || budgetSpent) {
      mRequestHost.clear();
      setPhase(kPhaseFailed,
               classifyFailure(mSawAssociated, mSawHandshake, mSawCompleted, link.online));
      emitState();
    }
    return;
  }

  if (mPhase == kPhaseScanning) return;  // deliverScan / noteScanFailed owns the exit

  if (link.locked) {
    setPhase(kPhaseLocked, kErrLinkLocked);
  } else if (link.online) {
    if (!link.ssid.empty()) mTargetSsid = link.ssid;
    setPhase(kPhaseOnline, kErrNone);
  } else if (mPhase == kPhaseOnline || mPhase == kPhaseLocked) {
    setPhase(kPhaseIdle, kErrNone);
  }
  emitState();
}

void BleProvisionSession::deliverScan(const std::vector<Network>& nets, bool cached,
                                      int nowMs) {
  (void)nowMs;
  if (mPhase != kPhaseScanning) return;
  int total = static_cast<int>(nets.size());
  if (total > kMaxScanNetworks) total = kMaxScanNetworks;
  for (int i = 0; i < total; ++i) {
    // An SSID off the air is the one field in this document a stranger writes,
    // and it is dropped rather than trimmed: a name we cannot round-trip is a
    // name the user cannot select anyway.
    if (!ble::ssidIsSafe(nets[static_cast<size_t>(i)].ssid)) continue;
    queue(ble::buildNet(i, total, nets[static_cast<size_t>(i)].ssid,
                        nets[static_cast<size_t>(i)].rssi,
                        nets[static_cast<size_t>(i)].secured, cached));
  }
  setPhase(mPhaseBeforeScan, total > 0 ? kErrNone : kErrScan);
  mLastStateDoc.clear();
  emitState();
}

void BleProvisionSession::noteScanFailed(int nowMs) {
  (void)nowMs;
  if (mPhase != kPhaseScanning) return;
  setPhase(mLocked ? kPhaseLocked : mPhaseBeforeScan,
           mLocked ? kErrLinkLocked : kErrScan);
  mLastStateDoc.clear();
  emitState();
}

}  // namespace tcos
