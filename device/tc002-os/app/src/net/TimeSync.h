#ifndef NET_TIMESYNC_H_
#define NET_TIMESYNC_H_

#include <pthread.h>
#include <stdint.h>

#include <string>
#include <vector>

namespace tcos {

/**
 * An SNTP client — the wall clock, on a device that is a clock.
 *
 * Nothing in this firmware ever called settimeofday, and until the flash that
 * was invisible: sideloaded, ZOS ran on top of a stock app that had already
 * NTP-synced at startup, and a kernel keeps the time set that way across a
 * framework restart. So ZOS inherited a correct clock it had never asked for.
 * Flashed, ZOS is the only app that has ever run — nothing has ever called
 * settimeofday, the SoC has no battery-backed RTC, and the wall clock is
 * whatever the kernel booted with, forever. Every internal timestamp here is
 * CLOCK_MONOTONIC and stays that way; this class exists purely so that the one
 * thing the user reads off the panel is true.
 *
 * The split in this file is deliberate: encoding a request, decoding a reply
 * and deciding whether a decoded time may be applied are pure static functions,
 * so the rules that are hardest to trigger against a real server — a
 * kiss-of-death packet, an unsynchronised server, a reply from 1970, the 2036
 * era rollover — are asserted on the host with no network at all. Only the
 * socket, the thread and settimeofday itself need hardware.
 *
 * It owns a thread because both halves of a sync block: resolution can sit on
 * an unreachable DNS server for seconds, and the round trip has to be waited
 * for. Neither may happen on the 25 fps render tick — this is the same reason
 * net/HostLink runs its own threads and WifiPolicy::Actuator forbids a blocking
 * DHCP call.
 *
 * It never gives up. A device that boots before the router does would otherwise
 * be a clock showing 1970 until someone power-cycles it, which is worse than a
 * clock showing nothing: the retry backs off but never stops, and a success is
 * followed by a re-sync every few hours, because this SoC's oscillator is the
 * only thing keeping time between syncs.
 *
 * The clock it sets is UTC, as settimeofday always is. Rendering a local time
 * from it is the caller's problem and needs a fixed offset rather than
 * localtime(): this rootfs carries no tzdata, so localtime() would silently
 * return UTC and look correct in the +0 timezone alone.
 */
class TimeSync {
 public:
  // RFC 4330 §4. Extension/authenticator fields a full NTP server may append
  // are neither sent nor read; the first 48 bytes are the whole protocol here.
  static const int kPacketBytes = 48;

  // Seconds between the NTP epoch (1900-01-01) and the Unix epoch.
  static const uint32_t kNtpToUnix = 2208988800u;

  /**
   * The window a decoded time has to land in to be believed.
   *
   * The floor is 2020-01-01: this firmware did not exist before it, so a reply
   * claiming anything earlier is junk, a stale packet, or an unsynchronised
   * server that answered anyway — and setting the panel to 1970 is exactly the
   * failure this class is here to end.
   *
   * The ceiling is INT32_MAX (2038-01-19T03:14:07Z), which is not a taste
   * judgement but this device's storage limit: glibc on arm-linux-gnueabihf has
   * a 32-bit time_t, so an instant past it cannot be stored, only misstored as
   * 1901. Note the wall is 2038, not the 2036 NTP rollover — a correctly
   * decoded era-1 timestamp from 2036 or 2037 is inside the window and is
   * applied (see ntpToUnix); it is only past 2038 that refusing becomes the
   * one honest thing a 32-bit clock can do.
   */
  static const int64_t kFloorUnix = 1577836800;    // 2020-01-01T00:00:00Z
  static const int64_t kCeilingUnix = 2147483647;  // 2038-01-19T03:14:07Z

  // Budgets. One read is 3 s because a server that has not answered in that
  // long on a LAN is not going to; two reads per server because a stray or
  // spoofed datagram arriving first must cost a retry, not the whole server.
  static const int kReadTimeoutMs = 3000;
  static const int kReadsPerServer = 2;
  // Retry cadence. Cold (never synced) caps at a minute: the usual cause is a
  // boot that beat the router, and the clock should be right within a minute of
  // the link coming up rather than at the end of some patient backoff. Warm
  // caps far higher — a failed re-sync is not urgent, the time is already close.
  static const int kFirstBackoffMs = 2000;
  static const int kColdBackoffCapMs = 60000;
  static const int kWarmBackoffCapMs = 600000;
  // Four hours. Long enough that this is not traffic anyone notices, short
  // enough that the SoC's oscillator cannot drift into a visibly wrong minute.
  static const int kResyncIntervalMs = 4 * 60 * 60 * 1000;

  /** What the settings screen needs: whether a sync landed, and when. */
  struct Status {
    bool synced;               // at least one reply has been accepted
    int64_t unixSeconds;       // the wall clock set by that sync; 0 = never
    uint64_t monoMs;           // CLOCK_MONOTONIC ms at that sync; 0 = never
    uint64_t lastAttemptMs;    // CLOCK_MONOTONIC ms the last attempt started
    int successes;
    int consecutiveFailures;   // reset on every accepted reply
    std::string server;        // which host answered, for the settings screen

    Status() : synced(false), unixSeconds(0), monoMs(0), lastAttemptMs(0),
               successes(0), consecutiveFailures(0) {}
  };

  TimeSync();
  ~TimeSync();

  /**
   * Spawns the worker. Safe to call once; a second call does nothing.
   *
   * Call it after the framework is up, for the same reason HostLink::start is
   * called there: this thread starts resolving immediately.
   */
  void start();
  void stop();

  /** Overrides the server list. Has no effect once start() has run. */
  void setServers(const std::vector<std::string>& servers);

  Status status() const;
  bool synced() const;

  /**
   * Servers that answer from a mainland-China home network, tried in order.
   *
   * ntp.aliyun.com first: it is what the stock TC002 firmware and most Chinese
   * consumer IoT reach for, so it is the one address on this list with direct
   * evidence of working from this device's own network. ntp1.aliyun.com is a
   * second host under the same operator — cheap insurance against one box being
   * down. cn.pool.ntp.org is a different operator entirely, which is what makes
   * it worth the third slot: an Alibaba-wide outage, or a DNS hijack of
   * aliyun.com, does not take it with it. ntp.ntsc.ac.cn (the National Time
   * Service Center) is authoritative and last, because it is the most likely of
   * the four to rate-limit an anonymous client.
   *
   * Deliberately no time.windows.com / time.google.com: reaching them from a
   * Chinese home network ranges from slow to impossible, and a server that
   * times out is a server that costs the boot sync three seconds.
   *
   * A numeric address is a legal entry too (resolution accepts literals), for
   * anyone who has to survive broken DNS — but none is hard-coded here, because
   * a hard-coded IP that has silently moved is worse than a name that fails.
   */
  static std::vector<std::string> defaultServers();

  // ---- pure; asserted on the host with no network ------------------------

  /**
   * Fills a 48-byte client request. `nonce` goes in the transmit timestamp,
   * where the server must echo it back in the originate field: that echo is the
   * only thing distinguishing this server's answer from a stale datagram or an
   * off-path forgery, and it is why nothing here needs a real clock to send.
   */
  static void buildRequest(uint8_t* out, uint64_t nonce);

  /**
   * Protocol-level decode: shape, mode, stratum, leap indicator, the nonce echo
   * and a non-zero transmit timestamp. Deliberately says nothing about whether
   * the time is sane — that is shouldApply's job, and keeping the two apart is
   * what lets a well-formed reply carrying an absurd time be tested as its own
   * case rather than as a malformed packet.
   */
  static bool parseReply(const uint8_t* packet, int bytes, uint64_t nonce,
                         int64_t* unixSeconds, int* microseconds);

  /**
   * NTP seconds to Unix seconds, across the 2036 rollover.
   *
   * RFC 4330 §3: the 32-bit field wraps in 2036, and a client resolves the era
   * by the high bit — set means 1968-2036, clear means 2036-2104. Getting this
   * wrong is not a 2036 problem, it is a today problem: it is exactly how a
   * garbage reply becomes a device set to 2106.
   */
  static int64_t ntpToUnix(uint32_t ntpSeconds);

  /** Inside the window this device can both believe and store. */
  static bool plausible(int64_t unixSeconds);

  /**
   * The whole apply policy, so it can be asserted rather than described.
   *
   * Forward only. The clock this replaces is a kernel boot value, which is
   * always behind, so every legitimate correction steps forward; a reply asking
   * this device to go backwards is either junk or an attack, and honouring it
   * would let anything on the LAN rewind the panel at will. The single
   * exception is a current clock that is itself outside the window — a device
   * booted into 1970 or shoved into 2106 has nothing worth preserving, and
   * stepping it back into the window is the repair, not a regression.
   */
  static bool shouldApply(int64_t candidate, int64_t current);

 private:
  TimeSync(const TimeSync&);
  TimeSync& operator=(const TimeSync&);

  static void* threadMain(void* self);
  void run();
  /**
   * One round trip. True when a server answered with a believable time — which
   * counts as a success even when no step was needed, or the whole steady state
   * (a re-sync finding the clock already right) would look like a failure and
   * retry forever.
   */
  bool syncOnce(const std::string& server);
  bool applyTime(int64_t unixSeconds, int microseconds);
  /** Sleeps in slices so stop() is never more than ~100 ms away. */
  void sleepMs(int ms);

  mutable pthread_mutex_t mLock;
  pthread_t mThread;
  bool mRunning;
  bool mThreadStarted;
  std::vector<std::string> mServers;
  Status mStatus;
  // Bumped per request and mixed into the nonce, so two requests issued inside
  // the same clock tick still differ.
  uint64_t mCounter;
};

}  // namespace tcos

#endif  // NET_TIMESYNC_H_
