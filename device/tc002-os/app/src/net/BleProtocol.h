#ifndef NET_BLEPROTOCOL_H_
#define NET_BLEPROTOCOL_H_

#include <stdint.h>

#include <string>
#include <utility>
#include <vector>

namespace tcos {
namespace ble {

/**
 * The wire between the console's Web Bluetooth page and this firmware.
 *
 * Everything in this file is pure, because every byte it handles arrives from
 * outside the process over an unauthenticated radio. A GATT write is the one
 * input this device takes from a stranger: no TCP handshake, no same-origin
 * check, no LAN membership — anyone within ten metres can send twenty bytes.
 * So the parser is strict rather than forgiving (the opposite of StateDoc,
 * which parses a document from a service we chose to trust and must survive a
 * field we have not heard of yet), and every rejection path is asserted on the
 * host.
 *
 * THREE LAYERS, kept separate on purpose:
 *
 *   1. FRAMING — 20-byte chunks with an explicit first/last/seq header. Not the
 *      vendor's 200 ms-of-silence rule (Z21_TC002_Demo/src/ble/bluetooth_service.cpp
 *      aggregates on an idle timer and hard-cuts at 4096 bytes mid-message):
 *      an idle timeout adds 200 ms to every request and turns a dropped chunk
 *      into a truncated message that still parses. Explicit framing costs one
 *      byte per chunk and cannot do either.
 *
 *   2. BODY — `KEY\tVALUE\n` lines, the same shape net/StateDoc parses for the
 *      console link. One format in the firmware rather than two.
 *
 *   3. CREDENTIAL SAFETY — ssidIsSafe / pskIsSafe. This is not politeness. The
 *      supplicant is driven by DeviceWifi::connect through
 *      `SET_NETWORK %d psk "%s"`, so a quote or a backslash arriving from the
 *      air would close the argument early and let the rest of the string be
 *      read as further control-socket syntax. The check lives here, next to the
 *      parser, and DeviceWifi calls it again on its own doorstep.
 *
 * 20 BYTES is not a guess and not negotiable. Web Bluetooth exposes no MTU and
 * offers no way to request one, so the console cannot know what was negotiated;
 * the ATT default of 23 leaves 20 bytes of payload per operation. Framing to
 * the floor means the two sides never have to agree on anything they cannot
 * both observe.
 */

// The service and its two characteristics. 128-bit and randomly generated: an
// unassigned 16-bit alias (the vendor uses 0xfff0/0xfff1/0xfff2) collides with
// real SIG assignments and with every other cheap peripheral in the phone's
// chooser, and iOS can only background-filter on a service UUID.
//
//   service 7a1f5b60-2c8e-4f3a-9d51-0b4e6c8a2d10
//   rx      7a1f5b61-...   console -> device, Write Request
//   tx      7a1f5b62-...   device -> console, Notify
//
// Stored big-endian (UUID text order). ATT and the advertisement both carry
// 128-bit UUIDs little-endian, so the transport reverses them on the way out;
// keeping the canonical order here is what makes the constant greppable against
// the console's own string.
extern const uint8_t kServiceUuid[16];
extern const uint8_t kRxUuid[16];
extern const uint8_t kTxUuid[16];

/** UUID text, for the breadcrumb log and the host check. */
std::string uuidToString(const uint8_t uuid[16]);

// --- layer 1: framing -------------------------------------------------------

// One ATT operation's worth of payload: 23-byte default ATT_MTU minus the
// 3-byte opcode+handle header.
static const int kChunkBytes = 20;
static const int kChunkPayload = kChunkBytes - 1;
// A logical message. 512 is the largest a single ATT value can ever be, and
// nothing this protocol carries comes close (an SSID is 32 bytes, a PSK 63) —
// it exists so a stranger cannot grow a buffer on a device with ~1 MB free by
// never setting the LAST bit.
static const int kMaxMessageBytes = 512;

static const uint8_t kFlagFirst = 0x80;
static const uint8_t kFlagLast = 0x40;
static const uint8_t kSeqMask = 0x3f;

/**
 * Splits `message` into chunks, each at most kChunkBytes.
 *
 * Returns false (and leaves `chunks` empty) for a message over
 * kMaxMessageBytes: the sender is us, so that is a bug to catch here rather
 * than a truncated notification for the console to puzzle over.
 */
bool encode(const std::string& message, std::vector<std::string>* chunks);

/**
 * Rebuilds messages from chunks, rejecting anything that is not one.
 *
 * A FIRST chunk always restarts, because a central that reconnects mid-message
 * is normal and must not need a resync command. Everything else that does not
 * fit — an orphan continuation, a sequence gap, an oversized chunk, an oversized
 * message — drops the buffer and says which, so the caller can answer
 * `evt err code=frame` instead of acting on half a message.
 */
class Reassembler {
 public:
  enum Result { kNeedMore, kComplete, kReject };

  Reassembler();

  void reset();
  /** `why` is a static string naming the rule that failed; never null on kReject. */
  Result push(const char* data, int len, std::string* out, const char** why);

  bool inProgress() const { return mInProgress; }
  /** Partial messages thrown away by a restart, for the breadcrumb line. */
  int restarts() const { return mRestarts; }

 private:
  std::string mBuffer;
  bool mInProgress;
  int mNextSeq;
  int mRestarts;
};

// --- layer 2: the message body ----------------------------------------------

/**
 * A parsed `KEY\tVALUE\n` document.
 *
 * Strict on every axis a stranger controls: field count, key charset, key
 * length, value length, control bytes, duplicate keys. A duplicate key is
 * rejected rather than resolved, because "last one wins" and "first one wins"
 * are both defensible and the difference is a way to smuggle an SSID past a
 * reader that checked the other one.
 */
class Message {
 public:
  static const int kMaxFields = 12;
  static const int kMaxKeyBytes = 16;
  // 63 for a PSK, 32 for an SSID; 160 leaves room for a future field without
  // leaving room for a payload.
  static const int kMaxValueBytes = 160;

  bool parse(const std::string& body, const char** why);

  bool has(const std::string& key) const;
  /** The value, or an empty string when the key is absent. */
  std::string get(const std::string& key) const;
  int size() const { return static_cast<int>(mFields.size()); }

 private:
  std::vector<std::pair<std::string, std::string> > mFields;
};

// --- layer 2: what this firmware sends --------------------------------------

std::string buildHello(const std::string& name, const std::string& build,
                       const std::string& mac);
/**
 * `evt state`. `err` may be null (no error) and `retrySeconds` is only emitted
 * when non-negative, which is the lockout countdown.
 *
 * THE PSK IS NOT A PARAMETER, and cannot be added to one: what the console
 * needs back is the SSID it named and the address it got. Same rule as
 * ProvisionLog — the API has no way to receive the secret.
 */
std::string buildState(const char* phase, const std::string& ssid, const std::string& ip,
                       const char* err, int retrySeconds);
std::string buildNet(int index, int total, const std::string& ssid, int rssi, bool secured,
                     bool cached);
std::string buildErr(const char* code);

// --- layer 3: credentials ---------------------------------------------------

/**
 * Whether an SSID may be handed to wpa_supplicant's control socket.
 *
 * 1..32 bytes (802.11 says 32 octets), no control bytes, and no `"` or `\` —
 * see the file comment for why those two are an injection and not a typo.
 * High bytes pass: a UTF-8 SSID is legal and common.
 */
bool ssidIsSafe(const std::string& ssid);

/**
 * Whether a passphrase may be handed to the control socket.
 *
 * Empty is legal and means an open network — SetupPortal::connect already
 * treats it that way, and DeviceWifi::connect turns it into key_mgmt NONE.
 * Otherwise 8..63, WPA's own range: a shorter one cannot work, and a 64-char
 * value would be a raw PSK hex string, which this path does not accept because
 * it would be quoted as a passphrase and silently fail to associate.
 */
bool pskIsSafe(const std::string& psk);

// --- the advertisement ------------------------------------------------------

/**
 * The 31-byte AD payload: Flags, the complete 128-bit service UUID, the name.
 *
 *   3 B  flags        len, 0x01, 0x06
 *  18 B  service UUID len, 0x07, 16 bytes little-endian
 *  10 B  local name   len, 0x09, "ZOS-A772"
 *  ----
 *  31 B
 *
 * Exactly full, which is why the name is eight characters and why the UUID is
 * advertised rather than left for the client to discover: the console filters
 * the chooser on the service, so without it every Bluetooth device in the room
 * is in the list.
 *
 * Flags is 0x06 — LE General Discoverable + BR/EDR Not Supported. The vendor
 * sends 0x50, which sets neither of those and sets a reserved bit; a BLE-only
 * peripheral that does not claim to be discoverable is a peripheral some
 * scanners filter out.
 *
 * A name too long for the remaining room is truncated and demoted to Shortened
 * Local Name (0x08), because a 31-byte overflow is silently dropped by the
 * controller and would leave the device advertising nothing at all.
 */
bool buildAdvertisingData(const std::string& name, std::vector<uint8_t>* out);

/** Six digits, never starting with zero: the panel shows it at 6 px per cell. */
std::string codeFromSeed(uint32_t seed);

}  // namespace ble
}  // namespace tcos

#endif  // NET_BLEPROTOCOL_H_
