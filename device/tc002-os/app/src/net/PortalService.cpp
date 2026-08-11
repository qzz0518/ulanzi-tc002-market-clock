#include "net/PortalService.h"

#include <unistd.h>

namespace tcos {

PortalService::PortalService()
    : mRunning(false), mThreadStarted(false), mPort(-1), mServed(0) {
  ::pthread_mutex_init(&mLock, 0);
}

PortalService::~PortalService() {
  stop();
  ::pthread_mutex_destroy(&mLock);
}

int PortalService::start(int port, HttpServer::Handler* handler) {
  if (mThreadStarted) return mPort;
  const int bound = mServer.start(port, handler);
  if (bound < 0) return -1;
  mPort = bound;
  mRunning = true;
  mThreadStarted = true;
  ::pthread_create(&mThread, 0, &PortalService::threadMain, this);
  return bound;
}

void PortalService::stop() {
  if (!mThreadStarted) return;
  mRunning = false;
  // The loop checks mRunning between accepts, so the longest wait is one accept
  // timeout. Closing the listening socket from this thread instead would race
  // the accept and is not worth the complication for a shutdown path.
  ::pthread_join(mThread, 0);
  mThreadStarted = false;
  mServer.stop();
}

void* PortalService::threadMain(void* self) {
  static_cast<PortalService*>(self)->run();
  return 0;
}

void PortalService::run() {
  while (mRunning) {
    // 400 ms: short enough that stop() returns promptly, long enough that an
    // idle device is not spinning through accept calls.
    if (mServer.serveOnce(400)) {
      ::pthread_mutex_lock(&mLock);
      ++mServed;
      ::pthread_mutex_unlock(&mLock);
    }
  }
}

int PortalService::served() const {
  ::pthread_mutex_lock(&mLock);
  const int value = mServed;
  ::pthread_mutex_unlock(&mLock);
  return value;
}

}  // namespace tcos
