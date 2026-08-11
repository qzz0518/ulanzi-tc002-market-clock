#ifndef NET_PORTALSERVICE_H_
#define NET_PORTALSERVICE_H_

#include <pthread.h>

#include <string>

#include "net/HttpServer.h"

namespace tcos {

/**
 * Runs an HttpServer on its own thread.
 *
 * HttpServer::serveOnce blocks until a connection arrives or its timeout
 * expires, which is exactly right for a device that has nothing else to do
 * while provisioning — and exactly wrong for this firmware, whose UI tick runs
 * at 25 fps and must never stall. One thread, one accept loop, and the panel
 * never knows the difference.
 *
 * Deliberately started while the device is ONLINE and on its normal address,
 * not only while a hotspot is up. The provisioning page, its routes, the
 * network list and the submit round trip are then all reachable from a laptop
 * on the same LAN, so the whole flow can be exercised without touching the
 * radio — which matters because adb reaches this device over that same link and
 * a mistake there costs a physical power cycle.
 */
class PortalService {
 public:
  PortalService();
  ~PortalService();

  /**
   * Binds `port` and starts serving. Returns the bound port, or -1. `handler`
   * must outlive the service.
   */
  int start(int port, HttpServer::Handler* handler);
  void stop();

  bool running() const { return mRunning; }
  int port() const { return mPort; }

  /** Requests served since start; the settings screen shows it as a heartbeat. */
  int served() const;

 private:
  PortalService(const PortalService&);
  PortalService& operator=(const PortalService&);

  static void* threadMain(void* self);
  void run();

  HttpServer mServer;
  pthread_t mThread;
  mutable pthread_mutex_t mLock;
  bool mRunning;
  bool mThreadStarted;
  int mPort;
  int mServed;
};

}  // namespace tcos

#endif  // NET_PORTALSERVICE_H_
