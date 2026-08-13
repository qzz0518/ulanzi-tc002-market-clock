#include "platform/BleService.h"

#include <endian.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <os/SystemProperties.h>

#include "base/log.h"
#include "platform/InstallMode.h"
#include "platform/ProvisionLog.h"

namespace tcos {

namespace {

// --- the kernel's Bluetooth ABI ---------------------------------------------
//
// Declared here rather than included: this device ships no libbluetooth and the
// toolchain has no bluetooth headers, so the alternative to twenty lines of
// struct definitions is a 124 KB static BlueZ that does not fit in the link
// budget (see the class comment). Every value below is copied from the kernel's
// own uapi and cross-checked against the vendor's vendored headers in
// Z21_TC002_Demo/src/dependencies/include/ble/.

#ifndef AF_BLUETOOTH
#define AF_BLUETOOTH 31
#endif
#ifndef PF_BLUETOOTH
#define PF_BLUETOOTH AF_BLUETOOTH
#endif

const int kBtProtoL2cap = 0;
const int kBtProtoHci = 1;
const int kSolHci = 0;
const int kSolBluetooth = 274;
const int kBtSecurity = 4;
const int kBtSecurityLow = 1;

const int kHciFilterOpt = 2;
const int kHciChannelRaw = 0;
const uint8_t kHciCommandPkt = 0x01;
const uint8_t kHciEventPkt = 0x04;
const uint8_t kEvtCmdComplete = 0x0e;
const uint8_t kEvtCmdStatus = 0x0f;

// Spelled with the kernel's own macro rather than the 0x400448c9 it expands to:
// a hand-copied ioctl number that is wrong fails as EINVAL on a socket, which
// looks exactly like a controller that refused to come up.
#define ZOS_HCIDEVUP _IOW('H', 201, int)

const uint16_t kOgfLeCtl = 0x08;
const uint16_t kOcfLeSetAdvParams = 0x0006;
const uint16_t kOcfLeSetAdvData = 0x0008;
const uint16_t kOcfLeSetAdvEnable = 0x000a;

// L2CAP fixed channel 4 is ATT.
const uint16_t kAttCid = 4;
const uint8_t kBdaddrLePublic = 1;

typedef struct { uint8_t b[6]; } bdaddr_t;

struct sockaddr_l2 {
  sa_family_t l2_family;
  unsigned short l2_psm;
  bdaddr_t l2_bdaddr;
  unsigned short l2_cid;
  uint8_t l2_bdaddr_type;
};

struct sockaddr_hci {
  sa_family_t hci_family;
  unsigned short hci_dev;
  unsigned short hci_channel;
};

struct hci_filter {
  uint32_t type_mask;
  uint32_t event_mask[2];
  uint16_t opcode;
};

struct bt_security {
  uint8_t level;
  uint8_t key_size;
};

uint16_t opcodePack(uint16_t ogf, uint16_t ocf) {
  return static_cast<uint16_t>((ocf & 0x03ff) | (ogf << 10));
}

// --- ATT ---------------------------------------------------------------------
//
// The whole attribute database, and it really is this small: one primary service
// and two characteristics. The vendor's demo adds no GAP (0x1800) or GATT
// (0x1801) service either, so a client reads the device name off the
// advertisement and nowhere else.
const uint16_t kHandleService = 0x0001;
const uint16_t kHandleRxDecl = 0x0002;
const uint16_t kHandleRxValue = 0x0003;
const uint16_t kHandleTxDecl = 0x0004;
const uint16_t kHandleTxValue = 0x0005;
const uint16_t kHandleCccd = 0x0006;
const uint16_t kHandleLast = kHandleCccd;

const uint16_t kUuidPrimaryService = 0x2800;
const uint16_t kUuidCharacteristic = 0x2803;
const uint16_t kUuidCccd = 0x2902;

const uint8_t kCharPropWrite = 0x08;   // Write Request (with response)
const uint8_t kCharPropNotify = 0x10;

// The default ATT_MTU, and deliberately not negotiated upward. Web Bluetooth
// exposes no MTU and offers no way to ask for one, so a larger value would be a
// number only one side could see; framing to the floor means neither side has to
// agree on anything it cannot observe. 23 - 3 = the 20-byte chunk.
const uint16_t kAttMtu = 23;

const uint8_t kAttErrorRsp = 0x01;
const uint8_t kAttExchangeMtuReq = 0x02;
const uint8_t kAttExchangeMtuRsp = 0x03;
const uint8_t kAttFindInfoReq = 0x04;
const uint8_t kAttFindInfoRsp = 0x05;
const uint8_t kAttReadByTypeReq = 0x08;
const uint8_t kAttReadByTypeRsp = 0x09;
const uint8_t kAttReadReq = 0x0a;
const uint8_t kAttReadRsp = 0x0b;
const uint8_t kAttReadByGroupReq = 0x10;
const uint8_t kAttReadByGroupRsp = 0x11;
const uint8_t kAttWriteReq = 0x12;
const uint8_t kAttWriteRsp = 0x13;
const uint8_t kAttNotification = 0x1b;

const uint8_t kAttErrInvalidHandle = 0x01;
const uint8_t kAttErrReadNotPermitted = 0x02;
const uint8_t kAttErrWriteNotPermitted = 0x03;
const uint8_t kAttErrInvalidPdu = 0x04;
const uint8_t kAttErrRequestNotSupported = 0x06;
const uint8_t kAttErrAttributeNotFound = 0x0a;
const uint8_t kAttErrInvalidValueLength = 0x0d;
const uint8_t kAttErrUnsupportedGroupType = 0x10;

void put16(uint8_t* at, uint16_t value) {
  at[0] = static_cast<uint8_t>(value & 0xff);
  at[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

uint16_t get16(const uint8_t* at) {
  return static_cast<uint16_t>(at[0] | (static_cast<uint16_t>(at[1]) << 8));
}

// 128-bit UUIDs travel least-significant byte first on both ATT and the
// advertisement; ble::k*Uuid is stored in text order.
void putUuid128(uint8_t* at, const uint8_t uuid[16]) {
  for (int i = 0; i < 16; ++i) at[i] = uuid[15 - i];
}

long monotonicMs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<long>(ts.tv_sec) * 1000L + ts.tv_nsec / 1000000L;
}

void sleepMs(int ms) {
  struct timespec ts;
  ts.tv_sec = ms / 1000;
  ts.tv_nsec = static_cast<long>(ms % 1000) * 1000000L;
  ::nanosleep(&ts, 0);
}

bool pathExists(const char* path) { return ::access(path, F_OK) == 0; }

void logStep(const char* tag, const char* fields) {
  ProvisionLog::device().log(tag, std::string(fields));
}

/**
 * One HCI command, waiting for its Command Complete.
 *
 * Returns false when the command could not be sent or no matching completion
 * arrived inside the budget; `status` carries the controller's own byte when it
 * did. Status 0x0C on Set Advertise Enable means "already advertising", which is
 * a success for our purposes and the vendor treats it the same way.
 */
bool hciCommand(int fd, uint16_t ogf, uint16_t ocf, const uint8_t* param, int plen,
                uint8_t* status) {
  *status = 0xff;
  const uint16_t opcode = opcodePack(ogf, ocf);

  struct hci_filter flt;
  ::memset(&flt, 0, sizeof(flt));
  flt.type_mask = 1u << (kHciEventPkt & 31);
  flt.event_mask[0] = (1u << (kEvtCmdComplete & 31)) | (1u << (kEvtCmdStatus & 31));
  if (::setsockopt(fd, kSolHci, kHciFilterOpt, &flt, sizeof(flt)) < 0) return false;

  uint8_t packet[3 + 1 + 255];
  packet[0] = kHciCommandPkt;
  put16(packet + 1, opcode);
  packet[3] = static_cast<uint8_t>(plen);
  if (plen > 0) ::memcpy(packet + 4, param, static_cast<size_t>(plen));
  if (::write(fd, packet, static_cast<size_t>(4 + plen)) < 0) return false;

  const long deadline = monotonicMs() + 1500;
  while (monotonicMs() < deadline) {
    struct pollfd pfd;
    pfd.fd = fd;
    pfd.events = POLLIN;
    pfd.revents = 0;
    const int ready = ::poll(&pfd, 1, 200);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (ready == 0) continue;
    uint8_t buf[260];
    const ssize_t n = ::read(fd, buf, sizeof(buf));
    if (n < 4) continue;
    if (buf[0] != kHciEventPkt) continue;
    const uint8_t evt = buf[1];
    if (evt == kEvtCmdComplete && n >= 7) {
      if (get16(buf + 4) != opcode) continue;
      *status = buf[6];
      return true;
    }
    if (evt == kEvtCmdStatus && n >= 7) {
      if (get16(buf + 5) != opcode) continue;
      *status = buf[3];
      return true;
    }
  }
  return false;
}

}  // namespace

BleService::BleService()
    : mThreadStarted(false),
      mRunning(false),
      // Default OFF. The worker decides on its first pass whether to touch the
      // HCI, and that pass can beat the owner's first setWanted() call — a
      // default of true made "never start BLE while the station link is up" a
      // race rather than a rule.
      mWanted(false),
      mStage(kStopped),
      mHciFd(-1),
      mListenFd(-1),
      mConnFd(-1),
      mAttempts(0),
      mAdvertisingOn(false),
      mNotifyEnabled(false) {
  ::pthread_mutex_init(&mLock, 0);
}

BleService::~BleService() {
  stop();
  ::pthread_mutex_destroy(&mLock);
}

uint32_t BleService::randomSeed() {
  uint32_t value = 0;
  const int fd = ::open("/dev/urandom", O_RDONLY);
  if (fd >= 0) {
    const ssize_t n = ::read(fd, &value, sizeof(value));
    ::close(fd);
    if (n == static_cast<ssize_t>(sizeof(value)) && value != 0) return value;
  }
  // The clock is a poor seed and a poor seed is still a code a stranger has to
  // read off the panel. The alternative — refuse to advertise — is worse.
  return static_cast<uint32_t>(monotonicMs()) * 2654435761u + 1u;
}

void BleService::start(const std::string& name) {
  ::pthread_mutex_lock(&mLock);
  mName = name;
  if (mThreadStarted) {
    ::pthread_mutex_unlock(&mLock);
    return;
  }
  mRunning = true;
  mStage = kStarting;
  ::pthread_mutex_unlock(&mLock);

  if (::pthread_create(&mThread, 0, &BleService::threadMain, this) != 0) {
    ::pthread_mutex_lock(&mLock);
    mRunning = false;
    mStage = kRadioDown;
    ::pthread_mutex_unlock(&mLock);
    logStep("BLE_START", "rc=thread");
    return;
  }
  mThreadStarted = true;
}

void BleService::stop() {
  ::pthread_mutex_lock(&mLock);
  const bool started = mThreadStarted;
  mRunning = false;
  ::pthread_mutex_unlock(&mLock);
  if (!started) return;
  ::pthread_join(mThread, 0);
  mThreadStarted = false;
  setStage(kStopped);
}

void BleService::setWanted(bool wanted) {
  ::pthread_mutex_lock(&mLock);
  // Re-arm on the rising edge. A stack that failed kMaxAttempts times parks for
  // good rather than flapping a shared radio unattended, and this is the one
  // deliberate way back in: a user walking into 配网 again is a human asking.
  if (wanted && !mWanted) mAttempts = 0;
  mWanted = wanted;
  ::pthread_mutex_unlock(&mLock);
}

BleService::Stage BleService::stage() const {
  ::pthread_mutex_lock(&mLock);
  const Stage stage = mStage;
  ::pthread_mutex_unlock(&mLock);
  return stage;
}

bool BleService::advertising() const {
  const Stage s = stage();
  return s == kAdvertising || s == kConnected;
}

bool BleService::connected() const { return stage() == kConnected; }

void BleService::setStage(Stage stage) {
  ::pthread_mutex_lock(&mLock);
  mStage = stage;
  ::pthread_mutex_unlock(&mLock);
}

void BleService::postEvent(Event event) {
  ::pthread_mutex_lock(&mLock);
  if (mEvents.size() < 32) mEvents.push_back(static_cast<int>(event));
  ::pthread_mutex_unlock(&mLock);
}

bool BleService::takeEvent(Event* event) {
  ::pthread_mutex_lock(&mLock);
  const bool have = !mEvents.empty();
  if (have) {
    *event = static_cast<Event>(mEvents.front());
    mEvents.erase(mEvents.begin());
  }
  ::pthread_mutex_unlock(&mLock);
  return have;
}

bool BleService::takeInbound(std::string* message) {
  ::pthread_mutex_lock(&mLock);
  const bool have = !mInbox.empty();
  if (have) {
    message->assign(mInbox.front());
    mInbox.erase(mInbox.begin());
  }
  ::pthread_mutex_unlock(&mLock);
  return have;
}

bool BleService::takeFrameError(std::string* why) {
  ::pthread_mutex_lock(&mLock);
  const bool have = !mFrameErrors.empty();
  if (have) {
    why->assign(mFrameErrors.front());
    mFrameErrors.erase(mFrameErrors.begin());
  }
  ::pthread_mutex_unlock(&mLock);
  return have;
}

void BleService::send(const std::string& message) {
  ::pthread_mutex_lock(&mLock);
  // Bounded: a console that subscribed and stopped reading must not be able to
  // grow this on a device with ~1 MB free.
  if (mOutbox.size() < 96) mOutbox.push_back(message);
  ::pthread_mutex_unlock(&mLock);
}

// --- bring-up ----------------------------------------------------------------

bool BleService::bringUp() {
  // STEP 0. The guard, and it is checked here rather than by the caller because
  // this is the last place before a socket is opened on the radio that carries
  // adb. On a flashed install it is always open; sideloaded it needs
  // /tmp/zos-allow-link, exactly like every other link mutation.
  if (!install::linkChangesAllowed()) {
    setStage(kBlocked);
    logStep("BLE_START", "rc=guard");
    return false;
  }

  // STEP 1. hciattach. /etc/init.rc declares it `disabled` + `oneshot`, so
  // nothing starts it at boot and nothing respawns it — the same ownership
  // problem wpa_supplicant has, with the same answer. The stock app starts it
  // too (device-dump/ps.txt captured it at pid 2230, after zkgui at 2113), so a
  // running one is adopted rather than restarted: `ctl.restart` would drop an
  // HCI link somebody else may be using.
  char svc[64];
  svc[0] = '\0';
  SystemProperties::getString("init.svc.hciattach", svc, "");
  const bool alreadyRunning = ::strcmp(svc, "running") == 0;
  if (!alreadyRunning) SystemProperties::setString("ctl.start", "hciattach");

  // STEP 2. Wait for the kernel to register the device. Deliberately NOT the
  // vendor's insmod branch: aic_btusb.ko is not on this unit (the attach is over
  // ttyS3, see the class comment) and an unconditional insmod/rmmod against this
  // combo part is the ADR 0006 hazard.
  const long deadline = monotonicMs() + kHciAppearMs;
  bool present = false;
  while (monotonicMs() < deadline) {
    if (pathExists("/sys/class/bluetooth/hci0")) {
      present = true;
      break;
    }
    sleepMs(kHciPollMs);
  }
  if (!present) {
    char fields[96];
    ::snprintf(fields, sizeof(fields), "rc=no-hci svc=%s adopted=%d", svc[0] ? svc : "-",
               alreadyRunning ? 1 : 0);
    logStep("BLE_START", fields);
    return false;
  }

  // STEP 3. HCIDEVUP. The ioctl rather than /res/bin/hciconfig: the binary lives
  // on the partition a flash of ZOS rewrites, and while the packer preserves it
  // (release/pack-image.ts substitutes three paths into the stock tree and
  // asserts tree parity), depending on a file we do not own for a step that is
  // one ioctl is a dependency for nothing.
  const int ctl = ::socket(AF_BLUETOOTH, SOCK_RAW, kBtProtoHci);
  if (ctl < 0) {
    logStep("BLE_START", "rc=no-hci-socket");
    return false;
  }
  const int up = ::ioctl(ctl, ZOS_HCIDEVUP, 0);
  const int upErr = errno;
  ::close(ctl);
  if (up < 0 && upErr != EALREADY) {
    char fields[64];
    ::snprintf(fields, sizeof(fields), "rc=devup errno=%d", upErr);
    logStep("BLE_START", fields);
    return false;
  }

  // STEP 4. The command channel.
  mHciFd = ::socket(AF_BLUETOOTH, SOCK_RAW, kBtProtoHci);
  if (mHciFd < 0) {
    logStep("BLE_START", "rc=no-cmd-socket");
    return false;
  }
  struct sockaddr_hci addr;
  ::memset(&addr, 0, sizeof(addr));
  addr.hci_family = AF_BLUETOOTH;
  addr.hci_dev = 0;
  addr.hci_channel = kHciChannelRaw;
  if (::bind(mHciFd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    char fields[64];
    ::snprintf(fields, sizeof(fields), "rc=bind errno=%d", errno);
    logStep("BLE_START", fields);
    return false;
  }

  char fields[96];
  ::snprintf(fields, sizeof(fields), "rc=ok hci=0 adopted=%d", alreadyRunning ? 1 : 0);
  logStep("BLE_START", fields);
  return true;
}

bool BleService::enableAdvertising(bool enable) {
  if (mHciFd < 0) return false;
  uint8_t status = 0xff;

  if (enable) {
    // Parameters, then data, then enable — the vendor's order, and the only one
    // the controller accepts: both of the first two are rejected while
    // advertising is already on.
    uint8_t params[15];
    ::memset(params, 0, sizeof(params));
    // 100–300 ms rather than the vendor's 20–300. A scan still finds this well
    // inside a second, and the fast end of that window is a duty cycle nobody
    // asked for on a unit that runs off a cell whenever it is unplugged.
    put16(params + 0, 0x00a0);  // min interval, 100 ms
    put16(params + 2, 0x01e0);  // max interval, 300 ms
    params[4] = 0x00;           // ADV_IND, connectable undirected
    params[5] = 0x00;           // own address type: public
    params[13] = 0x07;          // all three advertising channels
    params[14] = 0x00;          // no filter policy: accept any central
    if (!hciCommand(mHciFd, kOgfLeCtl, kOcfLeSetAdvParams, params, sizeof(params),
                    &status) ||
        status != 0) {
      char f[64];
      ::snprintf(f, sizeof(f), "rc=params status=%d", status);
      logStep("ADV_ENABLE", f);
      return false;
    }

    std::string name;
    ::pthread_mutex_lock(&mLock);
    name = mName;
    ::pthread_mutex_unlock(&mLock);
    std::vector<uint8_t> ad;
    if (!ble::buildAdvertisingData(name, &ad) || ad.size() > 31) {
      logStep("ADV_ENABLE", "rc=ad-size");
      return false;
    }
    uint8_t data[32];
    ::memset(data, 0, sizeof(data));
    data[0] = static_cast<uint8_t>(ad.size());
    for (size_t i = 0; i < ad.size(); ++i) data[1 + i] = ad[i];
    if (!hciCommand(mHciFd, kOgfLeCtl, kOcfLeSetAdvData, data, sizeof(data), &status) ||
        status != 0) {
      char f[64];
      ::snprintf(f, sizeof(f), "rc=data status=%d", status);
      logStep("ADV_ENABLE", f);
      return false;
    }
  }

  const uint8_t on = enable ? 1 : 0;
  if (!hciCommand(mHciFd, kOgfLeCtl, kOcfLeSetAdvEnable, &on, 1, &status)) {
    logStep("ADV_ENABLE", enable ? "rc=no-reply" : "rc=no-reply-off");
    return false;
  }
  // 0x0C is Command Disallowed, which for this command means the controller was
  // already in the state we asked for. The vendor logs it and carries on; so do
  // we, because failing here would take a working advertisement off the panel.
  if (status != 0 && status != 0x0c) {
    char f[64];
    ::snprintf(f, sizeof(f), "rc=enable status=%d on=%d", status, enable ? 1 : 0);
    logStep("ADV_ENABLE", f);
    return false;
  }
  mAdvertisingOn = enable;
  if (enable) {
    char f[80];
    ::snprintf(f, sizeof(f), "rc=ok status=%d uuid=%s", status,
               ble::uuidToString(ble::kServiceUuid).substr(0, 8).c_str());
    logStep("ADV_ENABLE", f);
  }
  return true;
}

bool BleService::openListener() {
  mListenFd = ::socket(PF_BLUETOOTH, SOCK_SEQPACKET, kBtProtoL2cap);
  if (mListenFd < 0) {
    logStep("BLE_LISTEN", "rc=socket");
    return false;
  }

  struct sockaddr_l2 addr;
  ::memset(&addr, 0, sizeof(addr));
  addr.l2_family = AF_BLUETOOTH;
  addr.l2_cid = htole16(kAttCid);
  addr.l2_bdaddr_type = kBdaddrLePublic;  // l2_bdaddr stays BDADDR_ANY
  if (::bind(mListenFd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    char f[64];
    ::snprintf(f, sizeof(f), "rc=bind errno=%d", errno);
    logStep("BLE_LISTEN", f);
    return false;
  }

  // BT_SECURITY_LOW: no pairing, no bonding, no LE encryption — the vendor's own
  // level. It is also the honest one: raising it pulls in SMP and an agent, and
  // a failed pairing on the only provisioning path this device has is a brick.
  // The six-digit code is authorisation, not confidentiality, and the gap is
  // written down in net/BleProvisionSession.h rather than papered over.
  struct bt_security sec;
  ::memset(&sec, 0, sizeof(sec));
  sec.level = kBtSecurityLow;
  if (::setsockopt(mListenFd, kSolBluetooth, kBtSecurity, &sec, sizeof(sec)) < 0) {
    char f[64];
    ::snprintf(f, sizeof(f), "rc=sec errno=%d", errno);
    logStep("BLE_LISTEN", f);
    return false;
  }

  if (::listen(mListenFd, 1) < 0) {
    char f[64];
    ::snprintf(f, sizeof(f), "rc=listen errno=%d", errno);
    logStep("BLE_LISTEN", f);
    return false;
  }
  return true;
}

void BleService::closeConnection(const char* reason) {
  if (mConnFd < 0) return;
  ::close(mConnFd);
  mConnFd = -1;
  mNotifyEnabled = false;
  mFramer.reset();
  ::pthread_mutex_lock(&mLock);
  mOutbox.clear();
  ::pthread_mutex_unlock(&mLock);
  logStep("BLE_DISC", (std::string("reason=") + reason).c_str());
  postEvent(kEventDisconnected);
}

void BleService::closeSockets() {
  closeConnection("shutdown");
  if (mListenFd >= 0) {
    ::close(mListenFd);
    mListenFd = -1;
  }
  if (mHciFd >= 0) {
    // Off the air, but the stack stays up: hciattach keeps running and hci0 stays
    // registered. Killing the UART attach on the chip that also carries wlan0
    // buys nothing and risks the only debug channel this unit has.
    //
    // Only when something was actually on the air. A bring-up that died at the
    // bind would otherwise log a failed disable on every retry, which is noise
    // in the one file a coordinator reads after a stranded session.
    if (mAdvertisingOn) enableAdvertising(false);
    ::close(mHciFd);
    mHciFd = -1;
  }
}

// --- ATT ---------------------------------------------------------------------

void BleService::sendAtt(const uint8_t* pdu, int len) {
  if (mConnFd < 0 || len <= 0) return;
  const ssize_t written = ::write(mConnFd, pdu, static_cast<size_t>(len));
  if (written < 0) closeConnection("write");
}

namespace {

void attError(uint8_t* out, uint8_t opcode, uint16_t handle, uint8_t error) {
  out[0] = kAttErrorRsp;
  out[1] = opcode;
  put16(out + 2, handle);
  out[4] = error;
}

// The characteristic declaration values, built once per request rather than
// stored: 19 bytes each, and the panel's RAM is worth more than the cycles.
int charDeclValue(uint16_t declHandle, uint8_t* out) {
  if (declHandle == kHandleRxDecl) {
    out[0] = kCharPropWrite;
    put16(out + 1, kHandleRxValue);
    putUuid128(out + 3, ble::kRxUuid);
    return 19;
  }
  if (declHandle == kHandleTxDecl) {
    out[0] = kCharPropNotify;
    put16(out + 1, kHandleTxValue);
    putUuid128(out + 3, ble::kTxUuid);
    return 19;
  }
  return 0;
}

// 0 means "this handle has a 128-bit UUID"; used by Find Information, which may
// not mix the two formats in one response.
uint16_t shortUuidFor(uint16_t handle) {
  switch (handle) {
    case kHandleService: return kUuidPrimaryService;
    case kHandleRxDecl: return kUuidCharacteristic;
    case kHandleTxDecl: return kUuidCharacteristic;
    case kHandleCccd: return kUuidCccd;
    default: return 0;
  }
}

}  // namespace

void BleService::handleAtt(const uint8_t* pdu, int len) {
  uint8_t out[kAttMtu];
  if (len < 1) return;
  const uint8_t opcode = pdu[0];

  switch (opcode) {
    case kAttExchangeMtuReq: {
      if (len != 3) {
        attError(out, opcode, 0, kAttErrInvalidPdu);
        sendAtt(out, 5);
        return;
      }
      // Answered with our own RX MTU. The client's value is read and ignored on
      // purpose: the negotiated MTU is min(ours, theirs), so answering 23 pins
      // it at 23 whatever they asked for, and the framing stops depending on a
      // number the console's own API refuses to expose.
      out[0] = kAttExchangeMtuRsp;
      put16(out + 1, kAttMtu);
      sendAtt(out, 3);
      return;
    }

    case kAttFindInfoReq: {
      if (len != 5) {
        attError(out, opcode, 0, kAttErrInvalidPdu);
        sendAtt(out, 5);
        return;
      }
      const uint16_t start = get16(pdu + 1);
      const uint16_t end = get16(pdu + 3);
      if (start == 0 || start > end) {
        attError(out, opcode, start, kAttErrInvalidHandle);
        sendAtt(out, 5);
        return;
      }
      int at = 2;
      int format = 0;
      for (uint16_t h = start; h <= end && h <= kHandleLast; ++h) {
        const uint16_t shortUuid = shortUuidFor(h);
        const int thisFormat = shortUuid != 0 ? 1 : 2;
        if (format == 0) format = thisFormat;
        if (thisFormat != format) break;
        const int entry = format == 1 ? 4 : 18;
        if (at + entry > static_cast<int>(kAttMtu)) break;
        put16(out + at, h);
        if (format == 1) {
          put16(out + at + 2, shortUuid);
        } else {
          putUuid128(out + at + 2, h == kHandleRxValue ? ble::kRxUuid : ble::kTxUuid);
        }
        at += entry;
      }
      if (format == 0) {
        attError(out, opcode, start, kAttErrAttributeNotFound);
        sendAtt(out, 5);
        return;
      }
      out[0] = kAttFindInfoRsp;
      out[1] = static_cast<uint8_t>(format);
      sendAtt(out, at);
      return;
    }

    case kAttReadByTypeReq: {
      if (len != 7 && len != 21) {
        attError(out, opcode, 0, kAttErrInvalidPdu);
        sendAtt(out, 5);
        return;
      }
      const uint16_t start = get16(pdu + 1);
      const uint16_t end = get16(pdu + 3);
      if (start == 0 || start > end) {
        attError(out, opcode, start, kAttErrInvalidHandle);
        sendAtt(out, 5);
        return;
      }
      // Only the characteristic declaration is discoverable this way. A client
      // asking for anything else gets Attribute Not Found rather than a guess.
      if (len != 7 || get16(pdu + 5) != kUuidCharacteristic) {
        attError(out, opcode, start, kAttErrAttributeNotFound);
        sendAtt(out, 5);
        return;
      }
      int at = 2;
      int count = 0;
      for (uint16_t h = start; h <= end && h <= kHandleLast; ++h) {
        uint8_t value[19];
        const int vlen = charDeclValue(h, value);
        if (vlen == 0) continue;
        if (at + 2 + vlen > static_cast<int>(kAttMtu)) break;
        put16(out + at, h);
        ::memcpy(out + at + 2, value, static_cast<size_t>(vlen));
        at += 2 + vlen;
        ++count;
        // One entry per response at this MTU (2 + 19 = 21, and 2 + 21 = 23), so
        // the loop stops here anyway; the break is what makes that explicit
        // rather than accidental.
        break;
      }
      if (count == 0) {
        attError(out, opcode, start, kAttErrAttributeNotFound);
        sendAtt(out, 5);
        return;
      }
      out[0] = kAttReadByTypeRsp;
      out[1] = 21;
      sendAtt(out, at);
      return;
    }

    case kAttReadByGroupReq: {
      if (len != 7 && len != 21) {
        attError(out, opcode, 0, kAttErrInvalidPdu);
        sendAtt(out, 5);
        return;
      }
      const uint16_t start = get16(pdu + 1);
      const uint16_t end = get16(pdu + 3);
      if (start == 0 || start > end) {
        attError(out, opcode, start, kAttErrInvalidHandle);
        sendAtt(out, 5);
        return;
      }
      if (len != 7 || get16(pdu + 5) != kUuidPrimaryService) {
        attError(out, opcode, start, kAttErrUnsupportedGroupType);
        sendAtt(out, 5);
        return;
      }
      if (start > kHandleService || end < kHandleService) {
        attError(out, opcode, start, kAttErrAttributeNotFound);
        sendAtt(out, 5);
        return;
      }
      out[0] = kAttReadByGroupRsp;
      out[1] = 20;  // handle + end group handle + 16-byte UUID
      put16(out + 2, kHandleService);
      put16(out + 4, kHandleLast);
      putUuid128(out + 6, ble::kServiceUuid);
      sendAtt(out, 22);
      return;
    }

    case kAttReadReq: {
      if (len != 3) {
        attError(out, opcode, 0, kAttErrInvalidPdu);
        sendAtt(out, 5);
        return;
      }
      const uint16_t handle = get16(pdu + 1);
      if (handle == kHandleCccd) {
        out[0] = kAttReadRsp;
        put16(out + 1, mNotifyEnabled ? 0x0001 : 0x0000);
        sendAtt(out, 3);
        return;
      }
      if (handle == kHandleService) {
        out[0] = kAttReadRsp;
        putUuid128(out + 1, ble::kServiceUuid);
        sendAtt(out, 17);
        return;
      }
      if (handle == kHandleRxDecl || handle == kHandleTxDecl) {
        uint8_t value[19];
        const int vlen = charDeclValue(handle, value);
        out[0] = kAttReadRsp;
        ::memcpy(out + 1, value, static_cast<size_t>(vlen));
        sendAtt(out, 1 + vlen);
        return;
      }
      if (handle == kHandleRxValue || handle == kHandleTxValue) {
        // Neither declares the Read property, and answering anyway would make
        // the declaration a lie.
        attError(out, opcode, handle, kAttErrReadNotPermitted);
        sendAtt(out, 5);
        return;
      }
      attError(out, opcode, handle, kAttErrInvalidHandle);
      sendAtt(out, 5);
      return;
    }

    case kAttWriteReq: {
      if (len < 3) {
        attError(out, opcode, 0, kAttErrInvalidPdu);
        sendAtt(out, 5);
        return;
      }
      const uint16_t handle = get16(pdu + 1);
      const int vlen = len - 3;
      if (handle == kHandleCccd) {
        if (vlen != 2) {
          attError(out, opcode, handle, kAttErrInvalidValueLength);
          sendAtt(out, 5);
          return;
        }
        const bool wasEnabled = mNotifyEnabled;
        mNotifyEnabled = (pdu[3] & 0x01) != 0;
        out[0] = kAttWriteRsp;
        sendAtt(out, 1);
        // SUBSCRIPTION IS THE REQUEST. A central that has just enabled
        // notifications wants to know what it connected to, and making it send
        // a hello for that would be a round trip whose answer is already
        // determined. Synthesised as an inbound message rather than answered
        // here, so there is exactly one place that decides what hello means and
        // it is the pure state machine, not the transport.
        if (mNotifyEnabled && !wasEnabled) {
          ::pthread_mutex_lock(&mLock);
          if (mInbox.size() < 16) mInbox.push_back(std::string("cmd\thello\n"));
          ::pthread_mutex_unlock(&mLock);
        }
        return;
      }
      if (handle != kHandleRxValue) {
        attError(out, opcode, handle,
                 handle <= kHandleLast ? kAttErrWriteNotPermitted : kAttErrInvalidHandle);
        sendAtt(out, 5);
        return;
      }
      // ACK FIRST, then parse. A malformed chunk must still be answered: an
      // unacknowledged Write Request stalls the client's whole GATT queue, and a
      // stranger who can stall us that cheaply does not need to be right about
      // anything else.
      out[0] = kAttWriteRsp;
      sendAtt(out, 1);

      std::string message;
      const char* why = "";
      const ble::Reassembler::Result result =
          mFramer.push(reinterpret_cast<const char*>(pdu + 3), vlen, &message, &why);
      if (result == ble::Reassembler::kComplete) {
        ::pthread_mutex_lock(&mLock);
        if (mInbox.size() < 16) mInbox.push_back(message);
        ::pthread_mutex_unlock(&mLock);
      } else if (result == ble::Reassembler::kReject) {
        ::pthread_mutex_lock(&mLock);
        if (mFrameErrors.size() < 8) mFrameErrors.push_back(std::string(why));
        ::pthread_mutex_unlock(&mLock);
      }
      return;
    }

    default:
      // Commands (bit 6) and confirmations are answered with silence, which is
      // what the spec requires; everything else gets a proper refusal so a
      // client is never left waiting on a response that is not coming.
      if ((opcode & 0x40) != 0 || opcode == 0x1e) return;
      attError(out, opcode, 0, kAttErrRequestNotSupported);
      sendAtt(out, 5);
      return;
  }
}

bool BleService::pumpOutbound() {
  if (mConnFd < 0 || !mNotifyEnabled) return false;
  // A bounded burst: enough to keep a 20-network scan list moving, short enough
  // that a stop request or an inbound write is never more than one burst away.
  for (int sent = 0; sent < 8; ++sent) {
    std::string message;
    ::pthread_mutex_lock(&mLock);
    const bool have = !mOutbox.empty();
    if (have) {
      message = mOutbox.front();
      mOutbox.erase(mOutbox.begin());
    }
    ::pthread_mutex_unlock(&mLock);
    if (!have) return sent > 0;

    std::vector<std::string> chunks;
    if (!ble::encode(message, &chunks)) continue;
    for (size_t i = 0; i < chunks.size() && mConnFd >= 0; ++i) {
      uint8_t pdu[kAttMtu];
      pdu[0] = kAttNotification;
      put16(pdu + 1, kHandleTxValue);
      ::memcpy(pdu + 3, chunks[i].data(), chunks[i].size());
      sendAtt(pdu, static_cast<int>(3 + chunks[i].size()));
    }
  }
  return true;
}

// --- the worker ---------------------------------------------------------------

void* BleService::threadMain(void* self) {
  static_cast<BleService*>(self)->run();
  return 0;
}

void BleService::run() {
  long nextAttemptMs = 0;
  bool up = false;

  for (;;) {
    ::pthread_mutex_lock(&mLock);
    const bool running = mRunning;
    const bool wanted = mWanted;
    const int attempts = mAttempts;
    ::pthread_mutex_unlock(&mLock);
    if (!running) break;

    if (!up) {
      if (!wanted || attempts >= kMaxAttempts || monotonicMs() < nextAttemptMs) {
        sleepMs(200);
        continue;
      }
      ::pthread_mutex_lock(&mLock);
      ++mAttempts;
      ::pthread_mutex_unlock(&mLock);
      setStage(kStarting);
      if (!bringUp() || !enableAdvertising(true) || !openListener()) {
        closeSockets();
        // Backoff, and then a hard stop. A radio shared with the only debug
        // channel this device has is not something to retry at forever.
        // `attempts` was read before the increment above, so it is 0 on the
        // first failure — using it directly made the first backoff zero and
        // turned the first retry into an immediate second attach.
        nextAttemptMs = monotonicMs() + 5000L * (attempts + 1);
        if (stage() != kBlocked) setStage(kRadioDown);
        postEvent(kEventRadioDown);
        continue;
      }
      up = true;
      ::pthread_mutex_lock(&mLock);
      mAttempts = 0;
      ::pthread_mutex_unlock(&mLock);
      setStage(kAdvertising);
      postEvent(kEventAdvertising);
      continue;
    }

    // Off the air on request, without tearing the stack down: one HCI command
    // out, one back in.
    if (!wanted) {
      if (mConnFd >= 0) closeConnection("not-wanted");
      enableAdvertising(false);
      setStage(kStopped);
      bool alive = true;
      for (;;) {
        ::pthread_mutex_lock(&mLock);
        const bool wantAgain = mWanted;
        alive = mRunning;
        ::pthread_mutex_unlock(&mLock);
        if (!alive || wantAgain) break;
        sleepMs(200);
      }
      if (!alive) break;
      if (!enableAdvertising(true)) {
        closeSockets();
        up = false;
        setStage(kRadioDown);
        postEvent(kEventRadioDown);
        continue;
      }
      setStage(kAdvertising);
      postEvent(kEventAdvertising);
      continue;
    }

    serviceConnection();
    // A stack that lost its listener cannot recover by looping on it; fall back
    // to the bring-up path, which is rate-limited and gives up after
    // kMaxAttempts rather than hammering a shared radio.
    if (mListenFd < 0) {
      closeSockets();
      up = false;
    }
  }

  closeSockets();
  setStage(kStopped);
}

void BleService::serviceConnection() {
  struct pollfd fds[2];
  int n = 0;
  if (mConnFd < 0 && mListenFd >= 0) {
    fds[n].fd = mListenFd;
    fds[n].events = POLLIN;
    fds[n].revents = 0;
    ++n;
  }
  if (mConnFd >= 0) {
    fds[n].fd = mConnFd;
    fds[n].events = POLLIN;
    fds[n].revents = 0;
    ++n;
  }
  if (n == 0) {
    sleepMs(200);
    return;
  }

  // 60 ms: fast enough that a notification queued by the UI tick goes out inside
  // one frame of the 160 ms link poll, cheap enough to be invisible.
  const int ready = ::poll(fds, static_cast<nfds_t>(n), 60);
  if (ready < 0 && errno != EINTR) {
    closeConnection("poll");
    sleepMs(200);
    return;
  }

  for (int i = 0; i < n && ready > 0; ++i) {
    if (fds[i].revents == 0) continue;
    if (fds[i].fd == mListenFd) {
      struct sockaddr_l2 peer;
      socklen_t plen = sizeof(peer);
      ::memset(&peer, 0, sizeof(peer));
      const int fd = ::accept(mListenFd, reinterpret_cast<struct sockaddr*>(&peer), &plen);
      if (fd < 0) continue;
      if (mConnFd >= 0) {
        // One central at a time, on purpose. The vendor's implementation
        // overwrites its att/gatt pair on every accept without unref'ing the
        // previous one, which leaks and orphans the first connection.
        ::close(fd);
        continue;
      }
      mConnFd = fd;
      mNotifyEnabled = false;
      mFramer.reset();
      // Nothing from the previous session survives into this one. A queued
      // notification is an answer to a question a DIFFERENT central asked, and
      // the state it carries is by then a claim about the past.
      ::pthread_mutex_lock(&mLock);
      mOutbox.clear();
      mInbox.clear();
      mFrameErrors.clear();
      ::pthread_mutex_unlock(&mLock);
      // A write that cannot drain must not wedge the worker: the peer is a phone
      // that may have walked out of range mid-message.
      struct timeval tv;
      tv.tv_sec = 2;
      tv.tv_usec = 0;
      ::setsockopt(mConnFd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
      setStage(kConnected);
      char f[64];
      ::snprintf(f, sizeof(f), "peer=%02x%02x", peer.l2_bdaddr.b[1], peer.l2_bdaddr.b[0]);
      logStep("BLE_CONN", f);
      postEvent(kEventConnected);
      continue;
    }

    if (fds[i].fd == mConnFd) {
      if ((fds[i].revents & (POLLHUP | POLLERR | POLLNVAL)) != 0) {
        closeConnection("hup");
      } else {
        uint8_t buf[64];
        const ssize_t got = ::read(mConnFd, buf, sizeof(buf));
        if (got <= 0) {
          closeConnection(got == 0 ? "eof" : "read");
        } else {
          handleAtt(buf, static_cast<int>(got));
        }
      }
    }
  }

  if (mConnFd < 0 && stage() == kConnected) {
    // The controller stopped advertising when the connection came up; nothing
    // else will put it back on the air.
    if (enableAdvertising(true)) {
      setStage(kAdvertising);
      postEvent(kEventAdvertising);
    } else {
      setStage(kRadioDown);
      postEvent(kEventRadioDown);
    }
  }

  pumpOutbound();
}

}  // namespace tcos
