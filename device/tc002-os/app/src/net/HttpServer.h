#ifndef NET_HTTPSERVER_H_
#define NET_HTTPSERVER_H_

#include <string>
#include <vector>

namespace tcos {

/**
 * A minimal HTTP/1.0 server for the provisioning page.
 *
 * civetweb-cxx is in the FlyThings registry, but pulling in an HTTP framework
 * for one two-field form is a poor trade on a device with ~1 MB free. The arcade
 * firmware already proved hand-rolled HTTP over a raw socket works here — that
 * was the client direction; this is ~200 lines of the server direction.
 *
 * Deliberately single-connection and blocking: it serves one phone, briefly,
 * while the device has no other job. It carries no POSIX-only-on-device calls,
 * so the request parser and the route table are exercised over loopback on the
 * build host rather than only on hardware.
 */
class HttpServer {
 public:
  struct Request {
    std::string method;
    std::string path;
    std::string query;   // everything after '?', undecoded
    std::string body;
  };

  struct Response {
    int status;
    std::string contentType;
    std::string body;

    Response() : status(200), contentType("text/plain; charset=utf-8") {}
  };

  class Handler {
   public:
    virtual ~Handler() {}
    virtual Response handle(const Request& request) = 0;
  };

  HttpServer();
  ~HttpServer();

  /** Binds and listens. Returns the bound port, or -1. Port 0 picks a free one. */
  int start(int port, Handler* handler);
  void stop();
  bool running() const { return mListenFd >= 0; }
  int port() const { return mPort; }

  /**
   * Accepts and serves at most one connection, waiting up to `timeoutMs`.
   * Returns true when a request was served. Called from the firmware's own
   * thread so the server never owns one.
   */
  bool serveOnce(int timeoutMs);

  // Parsing is pure and therefore directly testable, including the malformed
  // inputs a phone browser will happily send.
  static bool parseRequest(const std::string& raw, Request* out);
  static std::string formValue(const std::string& body, const std::string& key);
  static std::string urlDecode(const std::string& value);

  // A phone form post is tiny; anything larger is refused rather than buffered.
  static const int kMaxRequestBytes = 8192;

  /**
   * Deadline on one accepted connection, per read and in total.
   *
   * PortalService gives this class a single thread, so a connection that never
   * says anything is not a slow request, it is the setup page going away for
   * good. Four seconds is far longer than a form post over a two-metre WiFi link
   * and far shorter than a user's patience.
   */
  static const int kSocketTimeoutMs = 4000;
  static const int kRequestDeadlineMs = 8000;

 private:
  HttpServer(const HttpServer&);
  HttpServer& operator=(const HttpServer&);

  int mListenFd;
  int mPort;
  Handler* mHandler;
};

}  // namespace tcos

#endif  // NET_HTTPSERVER_H_
