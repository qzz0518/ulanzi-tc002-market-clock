#include "net/TimeSync.h"

#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

namespace tcos {

namespace {

uint64_t monoMs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000ull +
         static_cast<uint64_t>(ts.tv_nsec / 1000000);
}

uint64_t monoNs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000000000ull +
         static_cast<uint64_t>(ts.tv_nsec);
}

// NTP is big-endian on the wire regardless of the host, and this SoC is little
// endian, so every field goes through these rather than a struct overlay.
uint32_t readBe32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
}

uint64_t readBe64(const uint8_t* p) {
  return (static_cast<uint64_t>(readBe32(p)) << 32) |
         static_cast<uint64_t>(readBe32(p + 4));
}

void writeBe64(uint8_t* p, uint64_t value) {
  for (int i = 0; i < 8; ++i) {
    p[i] = static_cast<uint8_t>((value >> (56 - 8 * i)) & 0xFFu);
  }
}

// Packet layout, RFC 4330 §4. Named rather than spelled inline because the
// difference between byte 24 and byte 40 is the difference between checking the
// server's echo and reading the time it sent.
const int kOffsetOriginate = 24;
const int kOffsetTransmit = 40;

const int kNtpPort = 123;

}  // namespace

// Out-of-line definitions so these stay usable in any context, including one
// that takes their address; the in-class initializers above remain the values.
const int TimeSync::kPacketBytes;
const uint32_t TimeSync::kNtpToUnix;
const int64_t TimeSync::kFloorUnix;
const int64_t TimeSync::kCeilingUnix;
const int TimeSync::kReadTimeoutMs;
const int TimeSync::kReadsPerServer;
const int TimeSync::kFirstBackoffMs;
const int TimeSync::kColdBackoffCapMs;
const int TimeSync::kWarmBackoffCapMs;
const int TimeSync::kResyncIntervalMs;

TimeSync::TimeSync() : mRunning(false), mThreadStarted(false), mCounter(0) {
  ::pthread_mutex_init(&mLock, 0);
  mServers = defaultServers();
}

TimeSync::~TimeSync() {
  stop();
  ::pthread_mutex_destroy(&mLock);
}

std::vector<std::string> TimeSync::defaultServers() {
  std::vector<std::string> servers;
  servers.push_back("ntp.aliyun.com");
  servers.push_back("ntp1.aliyun.com");
  servers.push_back("cn.pool.ntp.org");
  servers.push_back("ntp.ntsc.ac.cn");
  return servers;
}

void TimeSync::setServers(const std::vector<std::string>& servers) {
  if (mThreadStarted || servers.empty()) return;
  ::pthread_mutex_lock(&mLock);
  mServers = servers;
  ::pthread_mutex_unlock(&mLock);
}

void TimeSync::start() {
  if (mThreadStarted) return;
  mRunning = true;
  mThreadStarted = true;
  ::pthread_create(&mThread, 0, &TimeSync::threadMain, this);
}

void TimeSync::stop() {
  if (!mThreadStarted) return;
  mRunning = false;
  // The loop checks mRunning between sleep slices and between servers, so the
  // longest wait here is one in-flight round trip: bounded by kReadTimeoutMs.
  ::pthread_join(mThread, 0);
  mThreadStarted = false;
}

void* TimeSync::threadMain(void* self) {
  static_cast<TimeSync*>(self)->run();
  return 0;
}

void TimeSync::buildRequest(uint8_t* out, uint64_t nonce) {
  ::memset(out, 0, static_cast<size_t>(kPacketBytes));
  // LI = 0 (no warning), VN = 4, Mode = 3 (client). Version 4 rather than 3
  // because every server that speaks 3 also answers 4, and a v4 server may
  // answer a v3 request with a v3 reply this parser would then have to accept.
  out[0] = static_cast<uint8_t>((0 << 6) | (4 << 3) | 3);
  // Everything else stays zero on purpose. A client with no clock has nothing
  // truthful to put in the reference or receive timestamps, and RFC 4330 §5
  // says a server ignores them; the transmit timestamp is the exception,
  // because whatever is written there comes back in the reply's originate field
  // and is therefore the only correlation this exchange has.
  writeBe64(out + kOffsetTransmit, nonce);
}

int64_t TimeSync::ntpToUnix(uint32_t ntpSeconds) {
  // RFC 4330 §3: the high bit selects the era. Set means era 0, the range that
  // started in 1968 and ends in February 2036; clear means era 1, which runs
  // from 2036 to 2104. The era-1 constant is 2^32 - kNtpToUnix.
  if ((ntpSeconds & 0x80000000u) != 0) {
    return static_cast<int64_t>(ntpSeconds) - static_cast<int64_t>(kNtpToUnix);
  }
  return static_cast<int64_t>(ntpSeconds) + 2085978496ll;
}

bool TimeSync::plausible(int64_t unixSeconds) {
  return unixSeconds >= kFloorUnix && unixSeconds <= kCeilingUnix;
}

bool TimeSync::shouldApply(int64_t candidate, int64_t current) {
  if (!plausible(candidate)) return false;
  // A current clock that is itself outside the window is a boot value, not a
  // time: there is nothing to preserve, so this is the one case that may step
  // backwards (a device shoved into 2106 has to be able to come home).
  if (!plausible(current)) return true;
  return candidate > current;
}

bool TimeSync::parseReply(const uint8_t* packet, int bytes, uint64_t nonce,
                          int64_t* unixSeconds, int* microseconds) {
  *unixSeconds = 0;
  *microseconds = 0;
  // Longer is legal — an authenticated server appends a key id and digest — but
  // shorter cannot be an SNTP reply at all.
  if (packet == 0 || bytes < kPacketBytes) return false;

  const uint8_t leap = static_cast<uint8_t>((packet[0] >> 6) & 0x03u);
  const uint8_t version = static_cast<uint8_t>((packet[0] >> 3) & 0x07u);
  const uint8_t mode = static_cast<uint8_t>(packet[0] & 0x07u);
  const uint8_t stratum = packet[1];

  // LI = 3 is the alarm condition: the server is running but has never
  // synchronised. It answers with a full-looking packet carrying its own boot
  // time, which is precisely the class of well-formed lie this client exists to
  // refuse.
  if (leap == 3) return false;
  if (version < 1 || version > 4) return false;
  // Mode 4 is "server". A reply in any other mode is not an answer to this
  // request — mode 3 would be another client's packet reaching this socket.
  if (mode != 4) return false;
  // Stratum 0 is a kiss-of-death packet (the ASCII code sits where the
  // reference id goes, usually RATE or DENY). Stratum 16 and above means
  // unsynchronised. Neither carries a usable time.
  if (stratum == 0 || stratum > 15) return false;

  // The echo. This is what makes a UDP exchange with no clock safe: only a
  // packet that came back from the request this client actually sent can carry
  // it, so a stale datagram from a previous attempt and an off-path forgery
  // that never saw the request are both rejected here.
  if (readBe64(packet + kOffsetOriginate) != nonce) return false;

  const uint32_t seconds = readBe32(packet + kOffsetTransmit);
  const uint32_t fraction = readBe32(packet + kOffsetTransmit + 4);
  // An all-zero transmit timestamp means the server never filled it in. It
  // would decode to 1900 and pass every structural check above.
  if (seconds == 0) return false;

  *unixSeconds = ntpToUnix(seconds);
  // The fraction is a binary fixed-point second. No round-trip compensation:
  // the delay on this radio is tens of milliseconds against a panel that
  // renders minutes, and halving an unvalidated delay is a way to import a
  // hostile server's latency claim rather than a way to be more accurate.
  *microseconds =
      static_cast<int>((static_cast<uint64_t>(fraction) * 1000000ull) >> 32);
  return true;
}

bool TimeSync::syncOnce(const std::string& server) {
  // Stamped before anything can fail, so "last tried" stays true even when the
  // attempt dies in resolution — which is exactly the shape of no network.
  ::pthread_mutex_lock(&mLock);
  mStatus.lastAttemptMs = monoMs();
  ::pthread_mutex_unlock(&mLock);

  struct addrinfo hints;
  ::memset(&hints, 0, sizeof(hints));
  // IPv4 only: this device has no IPv6 route, and asking for both means waiting
  // out an AAAA lookup that can only ever produce an address nothing can reach.
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  hints.ai_protocol = IPPROTO_UDP;

  // getaddrinfo rather than gethostbyname, which is what net/HttpClient uses:
  // gethostbyname returns a pointer into static storage, and this is a third
  // thread resolving names concurrently with that client's two. It also accepts
  // a numeric address without a lookup, so a literal in the server list works.
  char port[8];
  ::snprintf(port, sizeof(port), "%d", kNtpPort);
  struct addrinfo* resolved = 0;
  if (::getaddrinfo(server.c_str(), port, &hints, &resolved) != 0 || resolved == 0) {
    return false;
  }

  const int fd = ::socket(resolved->ai_family, resolved->ai_socktype,
                          resolved->ai_protocol);
  if (fd < 0) {
    ::freeaddrinfo(resolved);
    return false;
  }

  struct timeval tv;
  tv.tv_sec = kReadTimeoutMs / 1000;
  tv.tv_usec = (kReadTimeoutMs % 1000) * 1000;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

  // connect() on a UDP socket costs no packets and buys two things: the kernel
  // drops datagrams from anywhere but this server before they are ever read,
  // and an ICMP port-unreachable surfaces as a recv error instead of burning
  // the whole read budget on silence.
  const bool connected =
      ::connect(fd, resolved->ai_addr, resolved->ai_addrlen) == 0;
  ::freeaddrinfo(resolved);
  if (!connected) {
    ::close(fd);
    return false;
  }

  uint64_t nonce = 0;
  ::pthread_mutex_lock(&mLock);
  // The monotonic clock is the only unpredictable-ish value available before a
  // sync; the counter is what keeps two requests inside the same nanosecond
  // tick from colliding.
  nonce = monoNs() ^ (mCounter * 0x9E3779B97F4A7C15ull);
  ++mCounter;
  ::pthread_mutex_unlock(&mLock);

  uint8_t request[kPacketBytes];
  buildRequest(request, nonce);
  const ssize_t sent = ::send(fd, request, sizeof(request), 0);
  if (sent != static_cast<ssize_t>(sizeof(request))) {
    ::close(fd);
    return false;
  }

  int64_t unixSeconds = 0;
  int microseconds = 0;
  bool decoded = false;
  for (int attempt = 0; attempt < kReadsPerServer && !decoded; ++attempt) {
    uint8_t reply[128];  // 48 plus room for an authenticator that is ignored
    const ssize_t got = ::recv(fd, reply, sizeof(reply), 0);
    // A timeout or an error ends this server; only a datagram that arrived and
    // failed to decode is worth reading again, which is the stray-packet case
    // the retry exists for.
    if (got <= 0) break;
    decoded = parseReply(reply, static_cast<int>(got), nonce, &unixSeconds,
                         &microseconds);
  }
  ::close(fd);

  if (!decoded) return false;
  // A well-formed reply carrying an absurd time is a failure, not a success
  // with nothing to do: falling through to the next server is the only way a
  // single broken source cannot pin this device to a wrong year.
  if (!plausible(unixSeconds)) return false;

  // The return value is deliberately ignored: settimeofday failing with EPERM,
  // or the policy deciding no step was needed, are both compatible with having
  // heard a good time from a good server.
  applyTime(unixSeconds, microseconds);

  const uint64_t now = monoMs();
  ::pthread_mutex_lock(&mLock);
  // Recorded whether or not the clock actually moved. "Synced" answers "when
  // was this time last confirmed by a server", and a re-sync that found the
  // clock already right confirms it exactly as much as one that stepped it.
  mStatus.synced = true;
  mStatus.unixSeconds = unixSeconds;
  mStatus.monoMs = now;
  ++mStatus.successes;
  mStatus.consecutiveFailures = 0;
  mStatus.server = server;
  ::pthread_mutex_unlock(&mLock);
  return true;
}

bool TimeSync::applyTime(int64_t unixSeconds, int microseconds) {
  struct timeval current;
  if (::gettimeofday(&current, 0) != 0) return false;
  if (!shouldApply(unixSeconds, static_cast<int64_t>(current.tv_sec))) return false;

  struct timeval next;
  // The cast is safe only because shouldApply has already refused anything past
  // kCeilingUnix; on this device time_t is 32 bits and an unchecked value here
  // is how a clock ends up in 1901.
  next.tv_sec = static_cast<time_t>(unixSeconds);
  next.tv_usec = static_cast<suseconds_t>(microseconds);
  // EPERM when the process is not root, which is also what makes this safe to
  // link into the host self-check: it fails rather than moving the developer's
  // machine.
  return ::settimeofday(&next, 0) == 0;
}

void TimeSync::sleepMs(int ms) {
  for (int slept = 0; slept < ms && mRunning; slept += 100) {
    ::usleep(100000);
  }
}

void TimeSync::run() {
  int backoffMs = kFirstBackoffMs;

  while (mRunning) {
    std::vector<std::string> servers;
    ::pthread_mutex_lock(&mLock);
    servers = mServers;
    ::pthread_mutex_unlock(&mLock);

    bool ok = false;
    for (size_t i = 0; i < servers.size() && mRunning && !ok; ++i) {
      ok = syncOnce(servers[i]);
    }

    if (ok) {
      backoffMs = kFirstBackoffMs;
      // Long sleep, sliced: this is the steady state and it has to be both
      // invisible on the network and instantly interruptible at shutdown.
      sleepMs(kResyncIntervalMs);
      continue;
    }

    ::pthread_mutex_lock(&mLock);
    ++mStatus.consecutiveFailures;
    const bool warm = mStatus.synced;
    ::pthread_mutex_unlock(&mLock);

    sleepMs(backoffMs);
    // Never gives up, only slows down. A device that boots before its router —
    // the normal case after a power cut takes both — would otherwise show 1970
    // until someone noticed and power-cycled it.
    const int cap = warm ? kWarmBackoffCapMs : kColdBackoffCapMs;
    backoffMs *= 2;
    if (backoffMs > cap) backoffMs = cap;
  }
}

TimeSync::Status TimeSync::status() const {
  ::pthread_mutex_lock(&mLock);
  const Status copy = mStatus;
  ::pthread_mutex_unlock(&mLock);
  return copy;
}

bool TimeSync::synced() const {
  ::pthread_mutex_lock(&mLock);
  const bool value = mStatus.synced;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

}  // namespace tcos
