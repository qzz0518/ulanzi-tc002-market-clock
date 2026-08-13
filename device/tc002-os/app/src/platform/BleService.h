#ifndef PLATFORM_BLESERVICE_H_
#define PLATFORM_BLESERVICE_H_

#include <pthread.h>
#include <stdint.h>

#include <string>
#include <vector>

#include "net/BleProtocol.h"

namespace tcos {

/**
 * The BLE peripheral: HCI bring-up, one L2CAP ATT connection, a six-attribute
 * GATT database, and two mailboxes.
 *
 * WHY THIS IS HAND-ROLLED. The vendor's own demo links a static BlueZ
 * (`libgatt-server.a`, 13 objects) and the link closure for the API a port would
 * call measures 124,099 bytes of allocated sections. hostcheck/link-audit.sh
 * caps this firmware at 1,258,291 bytes and the shipped libzkgui.so is
 * 1,128,152 — about 130 KB of headroom, which BlueZ alone would eat before a
 * single line of provisioning logic. The device also ships no libbluetooth at
 * all, so there is nothing to link against dynamically, and the audit's
 * NEEDED-subset rule would reject one if there were. What is left is the kernel:
 * AF_BLUETOOTH sockets, an HCI command channel and an L2CAP SEQPACKET listener,
 * which is about the same amount of code as net/WpaCtrl.cpp already is for the
 * same reason.
 *
 * WHAT IT WILL NOT DO, and this is the part that matters more than the feature:
 *
 *   - It never calls rmmod or insmod. The vendor's startBluetooth() has a branch
 *     that inserts aic_btusb.ko, and the module directories it reaches for do
 *     not exist on this unit — that is the same class of call ADR 0006 exists to
 *     forbid, against the same combo part that carries wlan0.
 *   - It never stops wpa_supplicant, never touches hostapd, never asks for a
 *     DHCP lease. BLE and WiFi are separate functions of the aic8800 and this
 *     class stays on its side of that line.
 *   - It never stops hciattach on the way down. Killing the UART attach on a
 *     chip that is also carrying the only debug channel this device has buys
 *     nothing; disabling the advertisement is the part that costs power, and
 *     that is the part that gets turned off.
 *   - Every bring-up step is checked and every failure is terminal for BLE
 *     ONLY: the clock keeps running, the network is untouched, and the panel
 *     says 蓝牙未启动 rather than showing a name and a code that are not on the
 *     air.
 *
 * THREADING. One worker owns both sockets and never holds a lock while blocked.
 * Complete inbound messages, outbound messages and connect/disconnect edges pass
 * through mutex-guarded queues, and the UI tick drains them — the same shape as
 * the key queue in osLogic and for the same reason: the provisioning state
 * machine touches WifiPolicy, and WifiPolicy has no lock of its own because it
 * is only ever touched from the UI thread.
 */
class BleService {
 public:
  enum Stage {
    kStopped,     // never started, or stopped
    kBlocked,     // sideloaded with no /tmp/zos-allow-link; nothing was attempted
    kStarting,    // bring-up in progress
    kRadioDown,   // bring-up failed; the clock is fine, BLE is not
    kAdvertising, // on the air
    kConnected,   // a central is connected (the controller stops advertising)
  };

  enum Event { kEventAdvertising, kEventConnected, kEventDisconnected, kEventRadioDown };

  // Bring-up budgets, all measured against the vendor's own sequence.
  // hciattach is spawned by init and the kernel registers hci0 some tens of ms
  // later; the vendor waits 500 x 10 ms for it, and so do we.
  static const int kHciAppearMs = 5000;
  static const int kHciPollMs = 10;
  // Four attempts, then park. A bring-up that fails four times is not going to
  // succeed on the fifth, and a retry loop against a radio shared with wlan0 is
  // the last thing this device should be doing unattended.
  static const int kMaxAttempts = 4;

  BleService();
  ~BleService();

  /** Starts the worker. Idempotent; the name is what the advertisement carries. */
  void start(const std::string& name);
  /** Stops advertising and joins the worker. Leaves hci0 and hciattach alone. */
  void stop();

  /**
   * Whether the advertisement should be on the air right now.
   *
   * False takes the device off the air without tearing the stack down, which is
   * what an online clock wants: idle advertising at a 20–300 ms interval is not
   * free on a battery-backed unit, and re-enabling costs one HCI command rather
   * than another bring-up.
   */
  void setWanted(bool wanted);

  Stage stage() const;
  bool advertising() const;
  bool connected() const;

  /** One reassembled message from the central. */
  bool takeInbound(std::string* message);
  /** A chunk the framer rejected; the reason is BleProtocol's static string. */
  bool takeFrameError(std::string* why);
  /** A connect/disconnect/advertising edge, oldest first. */
  bool takeEvent(Event* event);

  /** Queues a message for notification. Dropped when nobody is subscribed. */
  void send(const std::string& message);

  /** Four bytes of /dev/urandom, or the monotonic clock when that fails. */
  static uint32_t randomSeed();

 private:
  BleService(const BleService&);
  BleService& operator=(const BleService&);

  static void* threadMain(void* self);
  void run();

  // Each returns false with the failing step already breadcrumbed.
  bool bringUp();
  bool enableAdvertising(bool enable);
  bool openListener();
  void closeSockets();
  void closeConnection(const char* reason);

  void serviceConnection();
  void handleAtt(const uint8_t* pdu, int len);
  void sendAtt(const uint8_t* pdu, int len);
  bool pumpOutbound();

  void setStage(Stage stage);
  void postEvent(Event event);

  mutable pthread_mutex_t mLock;
  pthread_t mThread;
  bool mThreadStarted;
  bool mRunning;
  bool mWanted;
  Stage mStage;
  std::string mName;

  // Worker-thread only.
  int mHciFd;
  int mListenFd;
  int mConnFd;
  int mAttempts;
  // Whether the controller was last told to advertise. Guards the disable on the
  // way down so a bring-up that never got that far does not log a failure.
  bool mAdvertisingOn;
  bool mNotifyEnabled;
  ble::Reassembler mFramer;

  std::vector<std::string> mInbox;
  std::vector<std::string> mFrameErrors;
  std::vector<std::string> mOutbox;
  std::vector<int> mEvents;
};

}  // namespace tcos

#endif  // PLATFORM_BLESERVICE_H_
