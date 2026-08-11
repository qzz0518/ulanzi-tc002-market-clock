#include "net/HttpClient.h"

#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

namespace tcos {

namespace {

// Case-insensitive header lookup. Header names are not case sensitive and Bun
// does not spell them the way this device's other peers do, so comparing them
// verbatim would work in the self check and fail on the LAN.
std::string headerValue(const std::string& headers, const std::string& name) {
  std::string lowered;
  lowered.reserve(headers.size());
  for (size_t i = 0; i < headers.size(); ++i) {
    const char c = headers[i];
    lowered.push_back(c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c);
  }
  std::string needle = "\r\n";
  needle += name;  // callers pass an already-lowercase name
  needle += ":";
  std::string::size_type at = lowered.find(needle);
  if (at == std::string::npos) return std::string();
  at += needle.size();
  std::string::size_type end = headers.find("\r\n", at);
  if (end == std::string::npos) end = headers.size();
  std::string value = headers.substr(at, end - at);
  std::string::size_type first = value.find_first_not_of(" \t");
  if (first == std::string::npos) return std::string();
  std::string::size_type last = value.find_last_not_of(" \t");
  return value.substr(first, last - first + 1);
}

bool sendAll(int fd, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    const ssize_t n = ::send(fd, data.data() + sent, data.size() - sent, 0);
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

int connectTo(const std::string& host, int port, int timeoutMs) {
  struct hostent* he = ::gethostbyname(host.c_str());
  if (he == 0 || he->h_length <= 0) return -1;
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;

  struct timeval tv;
  tv.tv_sec = timeoutMs / 1000;
  tv.tv_usec = (timeoutMs % 1000) * 1000;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  // The mirror upload is one small write per frame; without this each one waits
  // for an ACK of the previous and the stream paces itself down to a crawl.
  const int one = 1;
  ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

  struct sockaddr_in addr;
  ::memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<unsigned short>(port));
  ::memcpy(&addr.sin_addr, he->h_addr, static_cast<size_t>(he->h_length));
  if (::connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    ::close(fd);
    return -1;
  }
  return fd;
}

}  // namespace

bool HttpClient::parseUrl(const std::string& url, std::string* host, int* port,
                          std::string* path) {
  const std::string scheme = "http://";
  if (url.compare(0, scheme.size(), scheme) != 0) return false;
  const std::string rest = url.substr(scheme.size());
  const std::string::size_type slash = rest.find('/');
  const std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
  *path = slash == std::string::npos ? "/" : rest.substr(slash);
  const std::string::size_type colon = hostport.find(':');
  if (colon == std::string::npos) {
    *host = hostport;
    *port = 80;
  } else {
    *host = hostport.substr(0, colon);
    *port = ::atoi(hostport.substr(colon + 1).c_str());
  }
  return !host->empty() && *port > 0 && *port < 65536;
}

std::string HttpClient::buildRequest(const char* method, const std::string& path,
                                     const std::string& host,
                                     const std::string& contentType,
                                     const std::string& body) {
  char lenbuf[32];
  ::snprintf(lenbuf, sizeof(lenbuf), "%lu", static_cast<unsigned long>(body.size()));

  std::string out;
  out += method;
  out += " ";
  out += path;
  // 1.0 rather than 1.1 on purpose: it makes close-delimited the default framing
  // and keeps this client from having to implement keep-alive to be correct.
  out += " HTTP/1.0\r\nHost: ";
  out += host;
  out += "\r\nUser-Agent: ZOS/1\r\nConnection: close\r\n";
  if (::strcmp(method, "GET") != 0) {
    out += "Content-Type: ";
    out += contentType;
    out += "\r\nContent-Length: ";
    out += lenbuf;
    out += "\r\n";
  }
  out += "\r\n";
  if (::strcmp(method, "GET") != 0) out += body;
  return out;
}

bool HttpClient::dechunk(const std::string& raw, std::string* out) {
  out->clear();
  std::string::size_type at = 0;
  while (at < raw.size()) {
    const std::string::size_type eol = raw.find("\r\n", at);
    if (eol == std::string::npos) return false;
    // Chunk size is hex, optionally followed by ';' extensions we ignore.
    const long size = ::strtol(raw.substr(at, eol - at).c_str(), 0, 16);
    if (size < 0) return false;
    at = eol + 2;
    if (size == 0) return true;  // trailers, if any, are not interesting here
    if (at + static_cast<size_t>(size) > raw.size()) return false;
    out->append(raw, at, static_cast<size_t>(size));
    at += static_cast<size_t>(size) + 2;  // skip the chunk's trailing CRLF
  }
  // Running out mid-body is a truncated response, not a complete empty one.
  return false;
}

bool HttpClient::parseResponse(const std::string& raw, int* status, std::string* body) {
  *status = -1;
  body->clear();
  const std::string::size_type headerEnd = raw.find("\r\n\r\n");
  if (headerEnd == std::string::npos) return false;
  const std::string headers = raw.substr(0, headerEnd);

  const std::string::size_type sp = headers.find(' ');
  if (sp == std::string::npos) return false;
  *status = ::atoi(headers.substr(sp + 1, 3).c_str());
  if (*status < 100) return false;

  const std::string rest = raw.substr(headerEnd + 4);
  // "\r\n" prefixed so the search cannot match inside the status line, which is
  // also why the status line is never a header here.
  const std::string encoding = headerValue("\r\n" + headers, "transfer-encoding");
  if (encoding.find("chunked") != std::string::npos) return dechunk(rest, body);

  const std::string length = headerValue("\r\n" + headers, "content-length");
  if (!length.empty()) {
    const long declared = ::atol(length.c_str());
    if (declared < 0) return false;
    // Trust the smaller of the two: a short read is a truncated body, and a
    // longer one would mean reading into whatever followed.
    const size_t want = static_cast<size_t>(declared) < rest.size()
                            ? static_cast<size_t>(declared)
                            : rest.size();
    body->assign(rest, 0, want);
    return static_cast<size_t>(declared) == rest.size();
  }

  *body = rest;  // close-delimited
  return true;
}

bool HttpClient::perform(const std::string& url, const char* method,
                         const std::string& contentType, const std::string& body,
                         Response* out, int timeoutMs) {
  out->status = -1;
  out->body.clear();

  std::string host;
  std::string path;
  int port = 0;
  if (!parseUrl(url, &host, &port, &path)) return false;

  const int fd = connectTo(host, port, timeoutMs);
  if (fd < 0) return false;

  if (!sendAll(fd, buildRequest(method, path, host, contentType, body))) {
    ::close(fd);
    return false;
  }

  std::string raw;
  char buf[8192];
  bool overflowed = false;
  while (true) {
    const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
    if (n <= 0) break;  // 0 = orderly close, <0 = timeout or error
    if (raw.size() + static_cast<size_t>(n) > static_cast<size_t>(kMaxResponseBytes)) {
      overflowed = true;
      break;
    }
    raw.append(buf, static_cast<size_t>(n));

    // Stop as soon as a declared Content-Length is satisfied rather than waiting
    // for the peer's FIN: on the mirror upload that difference is a whole
    // round trip per frame.
    const std::string::size_type headerEnd = raw.find("\r\n\r\n");
    if (headerEnd != std::string::npos) {
      const std::string length =
          headerValue("\r\n" + raw.substr(0, headerEnd), "content-length");
      if (!length.empty()) {
        const size_t declared = static_cast<size_t>(::atol(length.c_str()));
        if (raw.size() - (headerEnd + 4) >= declared) break;
      }
    }
  }
  ::close(fd);
  if (overflowed) return false;

  return parseResponse(raw, &out->status, &out->body);
}

bool HttpClient::get(const std::string& url, Response* out, int timeoutMs) {
  return perform(url, "GET", std::string(), std::string(), out, timeoutMs);
}

}  // namespace tcos
