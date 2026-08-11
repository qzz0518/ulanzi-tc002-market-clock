#ifndef NET_SETUPPORTAL_H_
#define NET_SETUPPORTAL_H_

#include <string>
#include <vector>

#include "net/HttpServer.h"

namespace tcos {

/**
 * The provisioning web page and its routes.
 *
 * Served while the device is its own access point, which means the phone
 * connected to it has NO internet: the page must be entirely self-contained.
 * No CDN, no web font, no external stylesheet — any of those turn the setup
 * screen into a spinner with no explanation.
 *
 * The form lists networks the device scanned rather than asking the user to
 * type an SSID. On a phone keyboard one wrong character in an SSID looks
 * exactly like a wrong password, and the user has no way to tell which they got
 * wrong.
 */
class SetupPortal : public HttpServer::Handler {
 public:
  class Backend {
   public:
    virtual ~Backend() {}
    /** SSIDs currently visible, strongest first. May be empty while scanning. */
    virtual std::vector<std::string> scanResults() = 0;
    /**
     * Hand credentials to the WiFi policy. Returns false when the device
     * refused to act on them.
     *
     * The return value is not decoration. A submit that is silently dropped
     * leaves the page saying "submitted" while the device does nothing, and the
     * user waits for a reconnection that was never going to happen — the exact
     * failure this page exists to prevent. `reason` carries a short
     * machine-readable code the page shows verbatim.
     */
    virtual bool submit(const std::string& ssid, const std::string& psk,
                        std::string* reason) = 0;
    /** One of: "provisioning", "connecting", "online", "failed". */
    virtual std::string status() = 0;
    /** The address the device got, once online. */
    virtual std::string ipAddress() = 0;
  };

  explicit SetupPortal(Backend* backend);

  HttpServer::Response handle(const HttpServer::Request& request);

  // Exposed for the host self-check.
  static std::string jsonEscape(const std::string& value);
  static std::string htmlEscape(const std::string& value);

 private:
  HttpServer::Response page() const;
  HttpServer::Response scan() const;
  HttpServer::Response status() const;
  HttpServer::Response connect(const std::string& body);

  Backend* mBackend;
};

}  // namespace tcos

#endif  // NET_SETUPPORTAL_H_
