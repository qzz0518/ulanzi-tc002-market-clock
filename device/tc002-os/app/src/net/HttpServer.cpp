#include "net/HttpServer.h"

#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <cstdlib>

namespace tcos {

namespace {

int monotonicMs() {
  struct timespec ts;
  ::clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int>(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

const char* statusText(int status) {
  switch (status) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 409: return "Conflict";
    case 413: return "Payload Too Large";
    default: return "OK";
  }
}

}  // namespace

HttpServer::HttpServer() : mListenFd(-1), mPort(0), mHandler(0) {}

HttpServer::~HttpServer() {
  stop();
}

std::string HttpServer::urlDecode(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  for (size_t i = 0; i < value.size(); ++i) {
    const char c = value[i];
    if (c == '+') {
      out += ' ';
    } else if (c == '%' && i + 2 < value.size()) {
      const int hi = hexDigit(value[i + 1]);
      const int lo = hexDigit(value[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out += static_cast<char>((hi << 4) | lo);
        i += 2;
      } else {
        // A stray '%' is kept verbatim: a WPA passphrase may legitimately
        // contain one, and mangling it produces a wrong-password loop the user
        // has no way to diagnose.
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

std::string HttpServer::formValue(const std::string& body, const std::string& key) {
  const std::string needle = key + "=";
  size_t at = 0;
  while (at < body.size()) {
    size_t end = body.find('&', at);
    if (end == std::string::npos) end = body.size();
    const std::string pair = body.substr(at, end - at);
    if (pair.size() >= needle.size() && pair.compare(0, needle.size(), needle) == 0) {
      return urlDecode(pair.substr(needle.size()));
    }
    at = end + 1;
  }
  return std::string();
}

bool HttpServer::parseRequest(const std::string& raw, Request* out) {
  if (out == 0) return false;
  out->method.clear();
  out->path.clear();
  out->query.clear();
  out->body.clear();

  const size_t lineEnd = raw.find("\r\n");
  if (lineEnd == std::string::npos) return false;
  const std::string line = raw.substr(0, lineEnd);

  const size_t sp1 = line.find(' ');
  if (sp1 == std::string::npos) return false;
  const size_t sp2 = line.find(' ', sp1 + 1);
  if (sp2 == std::string::npos) return false;

  out->method = line.substr(0, sp1);
  std::string target = line.substr(sp1 + 1, sp2 - sp1 - 1);
  const size_t q = target.find('?');
  if (q == std::string::npos) {
    out->path = target;
  } else {
    out->path = target.substr(0, q);
    out->query = target.substr(q + 1);
  }
  if (out->method.empty() || out->path.empty() || out->path[0] != '/') return false;

  const size_t headerEnd = raw.find("\r\n\r\n");
  if (headerEnd != std::string::npos) out->body = raw.substr(headerEnd + 4);
  return true;
}

int HttpServer::start(int port, Handler* handler) {
  stop();
  mHandler = handler;

  mListenFd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (mListenFd < 0) return -1;

  int one = 1;
  ::setsockopt(mListenFd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

  struct sockaddr_in addr;
  ::memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons(static_cast<uint16_t>(port));
  if (::bind(mListenFd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    stop();
    return -1;
  }
  if (::listen(mListenFd, 4) < 0) {
    stop();
    return -1;
  }

  socklen_t len = sizeof(addr);
  if (::getsockname(mListenFd, reinterpret_cast<struct sockaddr*>(&addr), &len) == 0) {
    mPort = ntohs(addr.sin_port);
  } else {
    mPort = port;
  }
  return mPort;
}

void HttpServer::stop() {
  if (mListenFd >= 0) {
    ::close(mListenFd);
    mListenFd = -1;
  }
  mPort = 0;
}

bool HttpServer::serveOnce(int timeoutMs) {
  if (mListenFd < 0 || mHandler == 0) return false;

  fd_set readable;
  FD_ZERO(&readable);
  FD_SET(mListenFd, &readable);
  struct timeval tv;
  tv.tv_sec = timeoutMs / 1000;
  tv.tv_usec = (timeoutMs % 1000) * 1000;
  if (::select(mListenFd + 1, &readable, 0, 0, &tv) <= 0) return false;

  const int fd = ::accept(mListenFd, 0, 0);
  if (fd < 0) return false;

  // A DEADLINE ON THE CONVERSATION, not just on the accept. The select() above
  // covers the listening socket only; the recv loop below used to block with no
  // timeout at all, on the single thread PortalService runs. One client that
  // opened a connection and sent nothing took the setup page down for everyone,
  // permanently — and that client is not hypothetical on this path: iOS's
  // captive assistant pre-opens speculative sockets, and a phone that roams off
  // the hotspot mid-request leaves a half-open connection that never sends and
  // never resets. The symptom would have been "associated, addressed, page
  // dead", which costs the user the same wasted power cycle as no DHCP at all.
  struct timeval io;
  io.tv_sec = kSocketTimeoutMs / 1000;
  io.tv_usec = (kSocketTimeoutMs % 1000) * 1000;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &io, sizeof(io));
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &io, sizeof(io));

  // Read until the headers are complete, then until Content-Length is satisfied.
  // A phone form post is a few hundred bytes; anything past the cap is refused
  // rather than buffered, so a hostile client cannot grow this process.
  std::string raw;
  bool tooLarge = false;
  size_t contentLength = 0;
  bool haveHeaders = false;
  char buffer[1024];
  const int startedMs = monotonicMs();
  for (;;) {
    // The per-read timeout alone is not enough: a client dribbling one byte
    // inside every window would hold this thread for as long as it liked.
    if (monotonicMs() - startedMs > kRequestDeadlineMs) break;
    const ssize_t n = ::recv(fd, buffer, sizeof(buffer), 0);
    if (n <= 0) break;
    raw.append(buffer, static_cast<size_t>(n));
    if (raw.size() > static_cast<size_t>(kMaxRequestBytes)) {
      tooLarge = true;
      break;
    }
    if (!haveHeaders) {
      const size_t headerEnd = raw.find("\r\n\r\n");
      if (headerEnd == std::string::npos) continue;
      haveHeaders = true;
      // Case-insensitive enough for the handful of clients that reach this page.
      size_t at = raw.find("Content-Length:");
      if (at == std::string::npos) at = raw.find("content-length:");
      if (at != std::string::npos) {
        contentLength = static_cast<size_t>(::atoi(raw.c_str() + at + 15));
      }
      if (raw.size() >= headerEnd + 4 + contentLength) break;
    } else {
      const size_t headerEnd = raw.find("\r\n\r\n");
      if (raw.size() >= headerEnd + 4 + contentLength) break;
    }
  }

  Response response;
  if (tooLarge) {
    response.status = 413;
    response.body = "too large";
  } else {
    Request request;
    if (!parseRequest(raw, &request)) {
      response.status = 400;
      response.body = "bad request";
    } else {
      response = mHandler->handle(request);
    }
  }

  char header[256];
  const int headerLen = ::snprintf(
      header, sizeof(header),
      "HTTP/1.0 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
      "Cache-Control: no-store\r\nConnection: close\r\n\r\n",
      response.status, statusText(response.status), response.contentType.c_str(),
      static_cast<int>(response.body.size()));
  if (headerLen > 0) ::send(fd, header, static_cast<size_t>(headerLen), 0);
  if (!response.body.empty()) ::send(fd, response.body.data(), response.body.size(), 0);
  ::close(fd);
  return true;
}

}  // namespace tcos
