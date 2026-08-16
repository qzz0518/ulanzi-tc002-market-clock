#include "net/ConsoleDiscovery.h"

#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include "net/BleProtocol.h"
#include "net/HttpClient.h"
#include "platform/ProvisionLog.h"

namespace tcos {

const char* ConsoleDiscovery::kMagic = "ZOSCON1";
const char* ConsoleDiscovery::kProbePath = "/health";
// The first field of WorkspaceRuntimeSnapshot, as Bun's Response.json emits it:
// compact, no spaces. Matched as a substring because this device has no JSON
// parser and does not need one to answer "is that a console" — the alternative
// is 40 KB of parsing on a box with ~1 MB free.
const char* ConsoleDiscovery::kConsoleMark = "\"service\":\"ulanzi-tc002-content-hub\"";

namespace {

// Dotted-IPv4 only, and strict: this is the input to the /24 comparison, so an
// address it accepts loosely is a comparison that passes loosely.
bool parseIpv4(const std::string& value, unsigned char octets[4]) {
  int index = 0;
  size_t i = 0;
  while (index < 4) {
    if (i >= value.size() || value[i] < '0' || value[i] > '9') return false;
    int n = 0;
    int digits = 0;
    while (i < value.size() && value[i] >= '0' && value[i] <= '9') {
      n = n * 10 + (value[i] - '0');
      ++i;
      ++digits;
      if (n > 255 || digits > 3) return false;
    }
    octets[index] = static_cast<unsigned char>(n);
    ++index;
    if (index == 4) break;
    if (i >= value.size() || value[i] != '.') return false;
    ++i;
  }
  return i == value.size();
}

}  // namespace

bool ConsoleDiscovery::parseBeacon(const char* bytes, int len, Hint* out) {
  if (bytes == 0 || out == 0) return false;
  if (len <= 0 || len > kMaxDatagramBytes) return false;
  const std::string raw(bytes, static_cast<size_t>(len));

  // The frame. A datagram that does not end in the newline was cut short, and a
  // truncated address that happens to still parse is precisely the value that
  // must never reach /data/zos-host.
  if (raw[raw.size() - 1] != '\n') return false;
  const std::string line = raw.substr(0, raw.size() - 1);

  const std::string magic(kMagic);
  if (line.size() <= magic.size()) return false;
  if (line.compare(0, magic.size(), magic) != 0) return false;
  if (line[magic.size()] != '\t') return false;

  const size_t hostStart = magic.size() + 1;
  const size_t split = line.find('\t', hostStart);
  if (split == std::string::npos) return false;
  const std::string host = line.substr(hostStart, split - hostStart);
  const std::string portText = line.substr(split + 1);
  // Exactly three fields: a fourth tab is a payload this version does not
  // understand, and guessing at it is how a version tag stops meaning anything.
  if (portText.find('\t') != std::string::npos) return false;
  if (portText.empty() || portText.size() > 5) return false;
  for (size_t i = 0; i < portText.size(); ++i) {
    if (portText[i] < '0' || portText[i] > '9') return false;
  }
  const int port = ::atoi(portText.c_str());
  if (port <= 0 || port > 65535) return false;

  // The same validator the over-the-air path uses, because the destination is
  // the same file. A host that would be refused from a paired phone is not more
  // trustworthy for having arrived in a broadcast.
  if (!ble::hostIsSafe(host)) return false;

  out->host = host;
  out->port = port;
  return true;
}

bool ConsoleDiscovery::sameSlash24(const std::string& deviceIp, const std::string& host) {
  unsigned char mine[4];
  unsigned char theirs[4];
  if (!parseIpv4(deviceIp, mine)) return false;
  if (!parseIpv4(host, theirs)) return false;
  return mine[0] == theirs[0] && mine[1] == theirs[1] && mine[2] == theirs[2];
}

bool ConsoleDiscovery::lost(int failures) {
  // Failed polls, not elapsed silence. The pull is a long poll: a healthy clock
  // holds a request open for as long as nothing changes, so "no document for N
  // seconds" describes a working device just as well as a dead address. Only a
  // request that FAILED tells the two apart, and the backoff reaches two of
  // them in about two to four seconds.
  return failures >= kLostFailures;
}

std::string ConsoleDiscovery::hintHost(const Hint& hint) {
  if (hint.host.empty() || hint.port <= 0) return std::string();
  char port[8];
  ::snprintf(port, sizeof(port), "%d", hint.port);
  return hint.host + ":" + port;
}

std::string ConsoleDiscovery::hintUrl(const Hint& hint) {
  return ble::consoleUrl(hintHost(hint));
}

std::string ConsoleDiscovery::probeUrl(const std::string& baseUrl) {
  if (baseUrl.empty()) return std::string();
  std::string base = baseUrl;
  while (!base.empty() && base[base.size() - 1] == '/') base.erase(base.size() - 1);
  return base + kProbePath;
}

bool ConsoleDiscovery::consoleReply(int status, const std::string& body) {
  if (status < 200 || status >= 300) return false;
  return body.find(kConsoleMark) != std::string::npos;
}

std::string ConsoleDiscovery::candidate(const Link& link, const Hint& hint) {
  // Gate 1. First, and it is the cheap one: a device that is talking to its
  // console has no business looking at a stranger's packet at all.
  if (!lost(link.failures)) return std::string();
  // Gate 2.
  if (!sameSlash24(link.deviceIp, hint.host)) return std::string();
  const std::string url = hintUrl(hint);
  if (url.empty()) return std::string();
  // Gate 3. Both sides folded through the same normaliser, because "192.168.8.5",
  // "192.168.8.5:43820" and "http://192.168.8.5:43820" all name one console and
  // restarting the pull loop to move between those spellings is pure churn.
  if (url == ble::consoleUrl(link.baseUrl)) return std::string();
  return url;
}

ConsoleDiscovery::ConsoleDiscovery()
    : mRunning(false),
      mThreadStarted(false),
      mSocket(-1),
      mLastProbeMs(0),
      mProbeCount(0) {
  ::pthread_mutex_init(&mLock, 0);
}

ConsoleDiscovery::~ConsoleDiscovery() {
  stop();
  ::pthread_mutex_destroy(&mLock);
}

void ConsoleDiscovery::noteLink(const Link& link) {
  ::pthread_mutex_lock(&mLock);
  mLink = link;
  ::pthread_mutex_unlock(&mLock);
}

void ConsoleDiscovery::onDatagram(const char* bytes, int len) {
  Link link;
  ::pthread_mutex_lock(&mLock);
  link = mLink;
  const bool busy = !mPendingUrl.empty() || !mAdoptHost.empty();
  ::pthread_mutex_unlock(&mLock);
  // One candidate at a time. A second beacon arriving while the first is still
  // being proven must not overwrite it, or a sender that alternates two
  // addresses could keep the device probing and never adopting.
  if (busy) return;

  Hint hint;
  if (!parseBeacon(bytes, len, &hint)) return;
  const std::string url = candidate(link, hint);
  if (url.empty()) return;

  ::pthread_mutex_lock(&mLock);
  mPendingUrl = url;
  mPendingHost = hintHost(hint);
  // The address being replaced, captured with the candidate rather than read
  // again at adoption time: the log line has to name the pair that was actually
  // compared, and the pull loop could have been restarted in between.
  mPendingFrom = link.baseUrl.empty() ? std::string("none") : link.baseUrl;
  ::pthread_mutex_unlock(&mLock);
}

bool ConsoleDiscovery::pumpProbe() {
  std::string url;
  std::string host;
  std::string from;
  uint64_t nowMs = 0;
  ::pthread_mutex_lock(&mLock);
  nowMs = mLink.nowMs;
  const bool tooSoon = mLastProbeMs != 0 && nowMs >= mLastProbeMs &&
                       (nowMs - mLastProbeMs) < kProbeIntervalMs;
  if (!mPendingUrl.empty() && !tooSoon) {
    url = mPendingUrl;
    host = mPendingHost;
    from = mPendingFrom;
    mLastProbeMs = nowMs;
    ++mProbeCount;
  }
  ::pthread_mutex_unlock(&mLock);
  if (url.empty()) return false;

  // Gate 4. ONE request, and it happens BEFORE /data/zos-host is touched: a host
  // that merely shouts on the wire is not a console, and this is the only gate
  // that can tell the difference between the two.
  HttpClient::Response response;
  const bool ok = HttpClient::get(probeUrl(url), &response, kProbeTimeoutMs) &&
                  consoleReply(response.status, response.body);

  ::pthread_mutex_lock(&mLock);
  // Cleared either way: a candidate that failed its probe is spent, and the next
  // beacon from a host that really is a console will arm a fresh one.
  mPendingUrl.clear();
  mPendingHost.clear();
  mPendingFrom.clear();
  if (ok) mAdoptHost = host;
  ::pthread_mutex_unlock(&mLock);

  // logcat is banned on this unit, so /data/zos-provision.log is the ENTIRE
  // record of a device that changed the address it polls. Both outcomes are
  // logged: a refusal explains a clock that stayed lost while a console was
  // plainly on the air.
  const std::string fields = "from=" + from + " to=" + host +
                             (ok ? " outcome=adopt" : " outcome=not-a-console");
  ProvisionLog::device().log("host-discover", fields);
  return true;
}

bool ConsoleDiscovery::takeAdoption(std::string* host) {
  if (host == 0) return false;
  ::pthread_mutex_lock(&mLock);
  const bool ready = !mAdoptHost.empty();
  if (ready) {
    *host = mAdoptHost;
    mAdoptHost.clear();
  }
  ::pthread_mutex_unlock(&mLock);
  return ready;
}

int ConsoleDiscovery::probeCount() const {
  ::pthread_mutex_lock(&mLock);
  const int count = mProbeCount;
  ::pthread_mutex_unlock(&mLock);
  return count;
}

void ConsoleDiscovery::start(int port) {
  if (mThreadStarted) return;
  const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return;
  int reuse = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  struct sockaddr_in addr;
  ::memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (::bind(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) != 0) {
    ::close(fd);
    return;
  }
  // A read timeout rather than a blocking recvfrom: stop() has to be able to end
  // this thread, and a thread parked forever in the kernel cannot be asked to.
  struct timeval tv;
  tv.tv_sec = 1;
  tv.tv_usec = 0;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  mSocket = fd;
  mRunning = true;
  mThreadStarted = true;
  ::pthread_create(&mThread, 0, &ConsoleDiscovery::listenMain, this);
}

void ConsoleDiscovery::stop() {
  if (!mThreadStarted) return;
  mRunning = false;
  ::pthread_join(mThread, 0);
  mThreadStarted = false;
  if (mSocket >= 0) {
    ::close(mSocket);
    mSocket = -1;
  }
}

void* ConsoleDiscovery::listenMain(void* self) {
  static_cast<ConsoleDiscovery*>(self)->runListener();
  return 0;
}

void ConsoleDiscovery::runListener() {
  char buffer[kMaxDatagramBytes];
  while (mRunning) {
    // Gate 1, AHEAD OF THE READ. A clock that is talking to its console ignores
    // broadcasts completely, and "ignores" here means the bytes are never even
    // looked at — the datagram is drained off the socket so the buffer cannot
    // fill, and dropped.
    ::pthread_mutex_lock(&mLock);
    const Link link = mLink;
    ::pthread_mutex_unlock(&mLock);
    // REMEMBERING IS NOT ACTING. Every well-formed hint is parsed and kept,
    // healthy or not, so that the moment the console does go missing the
    // address is already in hand and the heal does not wait out a broadcast
    // interval. Nothing is adopted here — the four gates still stand, and
    // `lost` is checked where the decision is made, in pumpProbe/candidate.
    const ssize_t n = ::recvfrom(mSocket, buffer, sizeof(buffer), 0, 0, 0);
    if (n > 0) onDatagram(buffer, static_cast<int>(n));
    // Outside the branch: a candidate armed on a previous pass still has to be
    // proven even if this pass timed out with nothing on the wire.
    pumpProbe();
  }
}

}  // namespace tcos
