#ifndef NET_HTTPCLIENT_H_
#define NET_HTTPCLIENT_H_

#include <string>

namespace tcos {

/**
 * A minimal plaintext HTTP/1.0 client, the counterpart to net/HttpServer.
 *
 * The arcade firmware's pixelnet::NetClient proved raw sockets work on this
 * device, but it cannot serve this firmware: it only accepts status 200 (the
 * report endpoint answers 204), it hard-codes `Content-Type: application/json`
 * (the mirror upload is raw RGB), and it discards the response body (the mirror
 * upload's reply is how the device learns whether to keep streaming). Rather
 * than fork it three ways, this is the whole client in one place.
 *
 * The pure halves — building a request, parsing a response, de-chunking — are
 * static and asserted on the host. The socket half is plain POSIX, so the self
 * check drives a real request against a real net::HttpServer over loopback
 * rather than against a mock: the two were written to the same reading of
 * HTTP/1.0 and this is what proves they agree.
 */
class HttpClient {
 public:
  struct Response {
    int status;        // -1 when the exchange never produced a status line
    std::string body;
    // The raw header block, status line included, CRLF separated. Kept because
    // the frames endpoint answers with the revision it actually served: without
    // it the device can only record the revision the state document happened to
    // advertise when it decided to ask, and a save landing between those two
    // moments costs a redundant ~900 KB round trip.
    std::string headers;

    Response() : status(-1) {}
    bool ok() const { return status >= 200 && status < 300; }
    /** Case-insensitive lookup; `name` must be lowercase. Empty when absent. */
    std::string header(const char* name) const;
  };

  /**
   * One request/response. `contentType` and `body` are ignored for GET.
   *
   * `timeoutMs` is the per-read budget, not the total: the pull endpoint holds
   * a connection open for up to 8 s before answering, and a total budget would
   * have to be larger than the longest legitimate silence, which is exactly the
   * value that makes a dead peer take that long to notice.
   */
  static bool perform(const std::string& url, const char* method,
                      const std::string& contentType, const std::string& body,
                      Response* out, int timeoutMs);

  static bool get(const std::string& url, Response* out, int timeoutMs);

  /**
   * Where a streamed body goes. Two function pointers rather than an abstract
   * class: this device has one streaming caller and a vtable per sink is a cost
   * with nothing to buy.
   *
   * `ready` is called ONCE, after the status line and the headers are complete
   * and before a single body byte has been delivered, with the length the peer
   * declared or -1 when it declared none. Returning false abandons the exchange
   * having written nothing anywhere — which is the point of the callback: the
   * firmware image's size and status checks have to happen before a file is
   * opened, not after 8 MiB has landed on flash.
   *
   * `data` receives the body in arrival-sized pieces and returns false to abort.
   */
  struct Stream {
    bool (*ready)(void* ctx, const Response& head, long declaredBytes);
    bool (*data)(void* ctx, const char* bytes, size_t count);
    void* ctx;

    Stream() : ready(0), data(0), ctx(0) {}
  };

  /**
   * A GET whose body is handed to `sink` instead of being buffered.
   *
   * This exists because `get()` cannot serve the firmware image. It buffers the
   * whole reply and then copies the body out of it, so a 1.5 MB image is ~3 MB
   * of peak heap on a box with ~1 MB free — and the partition it is staged for
   * is 8 MiB, so the honest ceiling is over five times worse. The image also has
   * to reach a file rather than a string: it is written to flash afterwards, and
   * a truncated image that got that far is the one failure this whole path
   * exists to make impossible.
   *
   * Returns true ONLY when the exchange completed: headers parsed, `ready`
   * accepted, every `data` call accepted, and — when the peer declared a
   * Content-Length — exactly that many bytes delivered. A short read is
   * therefore false rather than a partial success, which is what lets the caller
   * treat `true` as "the whole image arrived".
   *
   * A reply that is not a plain 2xx, or one that is chunked, never reaches the
   * sink at all: it is buffered into `out->body` (bounded) and reported as a
   * failure. Error pages are small and worth reading; a chunked image cannot be
   * checked for completeness against a declared length, and "cannot be checked"
   * and "must not be flashed" are the same thing here.
   */
  static bool streamGet(const std::string& url, Response* out, const Stream& sink,
                        int timeoutMs);

  // Pure and therefore directly assertable, including on the malformed replies
  // a half-open connection produces.
  static bool parseUrl(const std::string& url, std::string* host, int* port,
                       std::string* path);
  static std::string buildRequest(const char* method, const std::string& path,
                                  const std::string& host,
                                  const std::string& contentType,
                                  const std::string& body);
  /**
   * Splits a raw exchange into status and body.
   *
   * Handles both framings a server may pick for an HTTP/1.0 request: an explicit
   * Content-Length, and close-delimited. Chunked is handled too — a server is
   * not supposed to chunk an HTTP/1.0 reply, but "not supposed to" is a poor
   * foundation for a firmware that cannot be debugged with a logcat.
   */
  static bool parseResponse(const std::string& raw, int* status, std::string* body,
                            std::string* headers = 0);

  /**
   * Case-insensitive header lookup over a raw header block.
   *
   * Header names are not case sensitive and Bun does not spell them the way
   * this device's other peers do, so comparing them verbatim would pass the
   * self check and fail on the LAN.
   */
  static std::string headerValue(const std::string& headers, const char* lowercaseName);

  /** Decodes a chunked body. Returns false on a malformed chunk header. */
  static bool dechunk(const std::string& raw, std::string* out);

  // A frame bundle for a 360-frame channel is ~900 KB; anything past this is a
  // service that has lost its mind, and buffering it would take the device with
  // it.
  static const int kMaxResponseBytes = 2 * 1024 * 1024;

  // A header block larger than this is a peer that has lost the plot, and
  // streamGet has to stop growing its buffer somewhere before the body starts.
  static const int kMaxHeaderBytes = 8192;

 private:
  HttpClient();
};

}  // namespace tcos

#endif  // NET_HTTPCLIENT_H_
