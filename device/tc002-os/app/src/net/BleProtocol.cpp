#include "net/BleProtocol.h"

#include <stdio.h>
#include <string.h>

namespace tcos {
namespace ble {

const uint8_t kServiceUuid[16] = {0x7a, 0x1f, 0x5b, 0x60, 0x2c, 0x8e, 0x4f, 0x3a,
                                  0x9d, 0x51, 0x0b, 0x4e, 0x6c, 0x8a, 0x2d, 0x10};
const uint8_t kRxUuid[16] = {0x7a, 0x1f, 0x5b, 0x61, 0x2c, 0x8e, 0x4f, 0x3a,
                             0x9d, 0x51, 0x0b, 0x4e, 0x6c, 0x8a, 0x2d, 0x10};
const uint8_t kTxUuid[16] = {0x7a, 0x1f, 0x5b, 0x62, 0x2c, 0x8e, 0x4f, 0x3a,
                             0x9d, 0x51, 0x0b, 0x4e, 0x6c, 0x8a, 0x2d, 0x10};

namespace {

// The AD types this firmware emits. Named rather than inlined because a wrong
// one produces a perfectly valid advertisement that no client can filter on.
const uint8_t kAdFlags = 0x01;
const uint8_t kAdCompleteUuid128 = 0x07;
const uint8_t kAdCompleteName = 0x09;
const uint8_t kAdShortenedName = 0x08;
const uint8_t kAdFlagsValue = 0x06;  // LE General Discoverable | BR/EDR Not Supported
const int kAdvertisingBytes = 31;

bool isControlByte(unsigned char c) { return c < 0x20 || c == 0x7f; }

bool keyCharAllowed(char c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
}

}  // namespace

std::string uuidToString(const uint8_t uuid[16]) {
  char out[40];
  ::snprintf(out, sizeof(out),
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             uuid[0], uuid[1], uuid[2], uuid[3], uuid[4], uuid[5], uuid[6], uuid[7],
             uuid[8], uuid[9], uuid[10], uuid[11], uuid[12], uuid[13], uuid[14],
             uuid[15]);
  return std::string(out);
}

// --- framing ----------------------------------------------------------------

bool encode(const std::string& message, std::vector<std::string>* chunks) {
  chunks->clear();
  if (static_cast<int>(message.size()) > kMaxMessageBytes) return false;

  size_t offset = 0;
  int seq = 0;
  // An empty message still produces one chunk: a header with FIRST and LAST and
  // no payload. The alternative — zero chunks — would be a send that silently
  // did nothing.
  do {
    const size_t take = message.size() - offset < static_cast<size_t>(kChunkPayload)
                            ? message.size() - offset
                            : static_cast<size_t>(kChunkPayload);
    const bool first = offset == 0;
    const bool last = offset + take >= message.size();
    std::string chunk;
    chunk.reserve(take + 1);
    uint8_t header = static_cast<uint8_t>(seq & kSeqMask);
    if (first) header |= kFlagFirst;
    if (last) header |= kFlagLast;
    chunk.push_back(static_cast<char>(header));
    chunk.append(message, offset, take);
    chunks->push_back(chunk);
    offset += take;
    seq = (seq + 1) & kSeqMask;
  } while (offset < message.size());
  return true;
}

Reassembler::Reassembler() : mInProgress(false), mNextSeq(0), mRestarts(0) {}

void Reassembler::reset() {
  mBuffer.clear();
  mInProgress = false;
  mNextSeq = 0;
}

Reassembler::Result Reassembler::push(const char* data, int len, std::string* out,
                                      const char** why) {
  *why = "";
  if (data == 0 || len < 1 || len > kChunkBytes) {
    reset();
    *why = "chunk-size";
    return kReject;
  }

  const uint8_t header = static_cast<uint8_t>(data[0]);
  const bool first = (header & kFlagFirst) != 0;
  const bool last = (header & kFlagLast) != 0;
  const int seq = header & kSeqMask;
  const int payload = len - 1;

  if (first) {
    // A central that dropped the link mid-message and came back is normal, and
    // it must not need a resync command to be understood. Counted, because a
    // stream that restarts constantly is a different bug from one that never
    // does.
    if (mInProgress) ++mRestarts;
    mBuffer.clear();
    mInProgress = true;
    mNextSeq = seq;
  } else if (!mInProgress) {
    reset();
    *why = "orphan";
    return kReject;
  }

  if (seq != mNextSeq) {
    reset();
    *why = "seq";
    return kReject;
  }
  if (static_cast<int>(mBuffer.size()) + payload > kMaxMessageBytes) {
    reset();
    *why = "overflow";
    return kReject;
  }

  mBuffer.append(data + 1, static_cast<size_t>(payload));
  mNextSeq = (mNextSeq + 1) & kSeqMask;

  if (!last) return kNeedMore;
  out->assign(mBuffer);
  reset();
  return kComplete;
}

// --- the message body -------------------------------------------------------

bool Message::parse(const std::string& body, const char** why) {
  mFields.clear();
  *why = "";
  if (body.empty() || static_cast<int>(body.size()) > kMaxMessageBytes) {
    *why = "size";
    return false;
  }

  size_t at = 0;
  while (at < body.size()) {
    size_t end = body.find('\n', at);
    const bool trailing = end == std::string::npos;
    if (trailing) end = body.size();
    const std::string line = body.substr(at, end - at);
    at = end + 1;
    // A trailing newline is fine; an empty line anywhere else is a malformed
    // document rather than something to skip past.
    if (line.empty()) {
      if (at >= body.size()) break;
      *why = "empty-line";
      return false;
    }

    const size_t tab = line.find('\t');
    if (tab == std::string::npos) {
      *why = "no-tab";
      return false;
    }
    const std::string key = line.substr(0, tab);
    const std::string value = line.substr(tab + 1);
    // One tab per line. Two would make "which half is the value" a matter of
    // taste, and a taste is a way in.
    if (value.find('\t') != std::string::npos) {
      *why = "extra-tab";
      return false;
    }
    if (key.empty() || static_cast<int>(key.size()) > kMaxKeyBytes) {
      *why = "key-size";
      return false;
    }
    for (size_t i = 0; i < key.size(); ++i) {
      if (!keyCharAllowed(key[i])) {
        *why = "key-charset";
        return false;
      }
    }
    if (static_cast<int>(value.size()) > kMaxValueBytes) {
      *why = "value-size";
      return false;
    }
    for (size_t i = 0; i < value.size(); ++i) {
      if (isControlByte(static_cast<unsigned char>(value[i]))) {
        *why = "value-control";
        return false;
      }
    }
    if (static_cast<int>(mFields.size()) >= kMaxFields) {
      *why = "fields";
      return false;
    }
    for (size_t i = 0; i < mFields.size(); ++i) {
      if (mFields[i].first == key) {
        *why = "duplicate";
        return false;
      }
    }
    mFields.push_back(std::make_pair(key, value));
  }

  if (mFields.empty()) {
    *why = "empty";
    return false;
  }
  return true;
}

bool Message::has(const std::string& key) const {
  for (size_t i = 0; i < mFields.size(); ++i) {
    if (mFields[i].first == key) return true;
  }
  return false;
}

std::string Message::get(const std::string& key) const {
  for (size_t i = 0; i < mFields.size(); ++i) {
    if (mFields[i].first == key) return mFields[i].second;
  }
  return std::string();
}

// --- what this firmware sends ------------------------------------------------

namespace {

// Values we emit are ours, but two of them are not: an SSID came off the air and
// an IP came from an ioctl. A tab or a newline in either would forge a field.
std::string safeValue(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  for (size_t i = 0; i < value.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(value[i]);
    out.push_back(isControlByte(c) ? ' ' : value[i]);
    if (static_cast<int>(out.size()) >= Message::kMaxValueBytes) break;
  }
  return out;
}

void appendField(std::string* doc, const char* key, const std::string& value) {
  *doc += key;
  *doc += '\t';
  *doc += safeValue(value);
  *doc += '\n';
}

}  // namespace

std::string buildHello(const std::string& name, const std::string& build,
                       const std::string& mac) {
  std::string doc;
  appendField(&doc, "evt", "hello");
  appendField(&doc, "name", name);
  appendField(&doc, "build", build);
  appendField(&doc, "mac", mac);
  return doc;
}

std::string buildState(const char* phase, const std::string& ssid, const std::string& ip,
                       const char* err, int retrySeconds) {
  std::string doc;
  appendField(&doc, "evt", "state");
  appendField(&doc, "phase", phase == 0 ? "" : phase);
  appendField(&doc, "ssid", ssid);
  appendField(&doc, "ip", ip);
  if (err != 0 && err[0] != '\0') appendField(&doc, "err", err);
  if (retrySeconds >= 0) {
    char buf[16];
    ::snprintf(buf, sizeof(buf), "%d", retrySeconds);
    appendField(&doc, "retry", buf);
  }
  return doc;
}

std::string buildNet(int index, int total, const std::string& ssid, int rssi, bool secured,
                     bool cached) {
  char buf[16];
  std::string doc;
  appendField(&doc, "evt", "net");
  ::snprintf(buf, sizeof(buf), "%d", index);
  appendField(&doc, "i", buf);
  ::snprintf(buf, sizeof(buf), "%d", total);
  appendField(&doc, "n", buf);
  appendField(&doc, "ssid", ssid);
  ::snprintf(buf, sizeof(buf), "%d", rssi);
  appendField(&doc, "rssi", buf);
  appendField(&doc, "sec", secured ? "wpa" : "open");
  appendField(&doc, "cached", cached ? "1" : "0");
  return doc;
}

std::string buildErr(const char* code) {
  std::string doc;
  appendField(&doc, "evt", "err");
  appendField(&doc, "code", code == 0 ? "" : code);
  return doc;
}

// --- credentials -------------------------------------------------------------

bool ssidIsSafe(const std::string& ssid) {
  if (ssid.empty() || ssid.size() > 32) return false;
  for (size_t i = 0; i < ssid.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(ssid[i]);
    if (isControlByte(c)) return false;
    if (c == '"' || c == '\\') return false;
  }
  return true;
}

bool pskIsSafe(const std::string& psk) {
  if (psk.empty()) return true;  // an open network
  if (psk.size() < 8 || psk.size() > 63) return false;
  for (size_t i = 0; i < psk.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(psk[i]);
    if (isControlByte(c)) return false;
    if (c == '"' || c == '\\') return false;
  }
  return true;
}

// --- the advertisement --------------------------------------------------------

bool buildAdvertisingData(const std::string& name, std::vector<uint8_t>* out) {
  out->clear();
  if (name.empty()) return false;

  out->push_back(2);
  out->push_back(kAdFlags);
  out->push_back(kAdFlagsValue);

  out->push_back(17);
  out->push_back(kAdCompleteUuid128);
  // ATT and the AD payload both carry a 128-bit UUID least-significant byte
  // first; kServiceUuid is stored in text order.
  for (int i = 15; i >= 0; --i) out->push_back(kServiceUuid[i]);

  const int room = kAdvertisingBytes - static_cast<int>(out->size()) - 2;
  if (room <= 0) {
    out->clear();
    return false;
  }
  const bool complete = static_cast<int>(name.size()) <= room;
  const int take = complete ? static_cast<int>(name.size()) : room;
  out->push_back(static_cast<uint8_t>(take + 1));
  out->push_back(complete ? kAdCompleteName : kAdShortenedName);
  for (int i = 0; i < take; ++i) out->push_back(static_cast<uint8_t>(name[i]));
  return true;
}

std::string codeFromSeed(uint32_t seed) {
  // 100000..999999. A leading zero would be dropped by a console that parses the
  // field as a number, and six digits is the width the panel is laid out for.
  const uint32_t value = 100000u + (seed % 900000u);
  char buf[16];
  ::snprintf(buf, sizeof(buf), "%u", static_cast<unsigned>(value));
  return std::string(buf);
}

}  // namespace ble
}  // namespace tcos
