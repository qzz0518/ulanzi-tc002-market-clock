#ifndef NET_NETCLIENT_H_
#define NET_NETCLIENT_H_

#include <string>

// Minimal plaintext HTTP/1.0 over a raw socket (no curl/openssl) for talking to
// the LAN Pixel Studio service: download a track, GET a small text body, or POST
// a small JSON body back (device key-press reports).
namespace pixelnet {

bool downloadFile(const std::string& url, const std::string& savePath, int timeoutMs = 20000);
bool httpGet(const std::string& url, std::string& outBody, int timeoutMs = 8000);
bool httpPost(const std::string& url, const std::string& body, int timeoutMs = 6000);

}  // namespace pixelnet

#endif  // NET_NETCLIENT_H_
