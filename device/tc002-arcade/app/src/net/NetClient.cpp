#include "net/NetClient.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netdb.h>

// Minimal plaintext HTTP/1.0 GET over a raw socket. The LAN service is HTTP, so
// this deliberately avoids curl/openssl and their whole TLS dependency chain —
// only libc sockets are used.
namespace pixelnet {
namespace {

bool parseUrl(const std::string& url, std::string& host, int& port, std::string& path) {
	const std::string scheme = "http://";
	if (url.compare(0, scheme.size(), scheme) != 0) return false;
	std::string rest = url.substr(scheme.size());
	std::string::size_type slash = rest.find('/');
	std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
	path = slash == std::string::npos ? "/" : rest.substr(slash);
	std::string::size_type colon = hostport.find(':');
	if (colon == std::string::npos) {
		host = hostport;
		port = 80;
	} else {
		host = hostport.substr(0, colon);
		port = atoi(hostport.substr(colon + 1).c_str());
	}
	return !host.empty() && port > 0;
}

int connectTo(const std::string& host, int port, int timeoutMs) {
	struct hostent* he = gethostbyname(host.c_str());
	if (!he || he->h_length <= 0) return -1;
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return -1;
	struct timeval tv;
	tv.tv_sec = timeoutMs / 1000;
	tv.tv_usec = (timeoutMs % 1000) * 1000;
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((unsigned short)port);
	memcpy(&addr.sin_addr, he->h_addr, he->h_length);
	if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

bool sendAll(int fd, const std::string& data) {
	size_t sent = 0;
	while (sent < data.size()) {
		ssize_t n = send(fd, data.data() + sent, data.size() - sent, 0);
		if (n <= 0) return false;
		sent += (size_t)n;
	}
	return true;
}

// GET url, streaming the body to a file and/or a string. Returns HTTP status.
int httpGetTo(const std::string& url, FILE* outFile, std::string* outStr, int timeoutMs) {
	std::string host, path;
	int port = 0;
	if (!parseUrl(url, host, port, path)) return -1;
	int fd = connectTo(host, port, timeoutMs);
	if (fd < 0) return -1;

	const std::string request =
		"GET " + path + " HTTP/1.0\r\nHost: " + host +
		"\r\nUser-Agent: TC002-PixelMusic\r\nConnection: close\r\n\r\n";
	if (!sendAll(fd, request)) { close(fd); return -1; }

	std::string header;
	char buf[4096];
	int status = -1;
	std::string bodyTail;
	bool haveHeader = false;
	while (!haveHeader) {
		ssize_t n = recv(fd, buf, sizeof(buf), 0);
		if (n <= 0) break;
		header.append(buf, (size_t)n);
		std::string::size_type end = header.find("\r\n\r\n");
		if (end != std::string::npos) {
			std::string::size_type sp = header.find(' ');
			if (sp != std::string::npos) status = atoi(header.substr(sp + 1, 3).c_str());
			bodyTail = header.substr(end + 4);
			haveHeader = true;
		}
	}
	if (status == 200) {
		if (!bodyTail.empty()) {
			if (outFile) fwrite(bodyTail.data(), 1, bodyTail.size(), outFile);
			if (outStr) outStr->append(bodyTail);
		}
		ssize_t n;
		while ((n = recv(fd, buf, sizeof(buf), 0)) > 0) {
			if (outFile) fwrite(buf, 1, (size_t)n, outFile);
			if (outStr) outStr->append(buf, (size_t)n);
		}
	}
	close(fd);
	return status;
}

}  // namespace

bool downloadFile(const std::string& url, const std::string& savePath, int timeoutMs) {
	FILE* f = fopen(savePath.c_str(), "wb");
	if (!f) return false;
	int status = httpGetTo(url, f, NULL, timeoutMs);
	fclose(f);
	return status == 200;
}

bool httpGet(const std::string& url, std::string& outBody, int timeoutMs) {
	outBody.clear();
	return httpGetTo(url, NULL, &outBody, timeoutMs) == 200;
}

// POST a small JSON body; returns true on HTTP 200. Used for device→service
// key-press reports, so we only care about the status line, not the response.
bool httpPost(const std::string& url, const std::string& body, int timeoutMs) {
	std::string host, path;
	int port = 0;
	if (!parseUrl(url, host, port, path)) return false;
	int fd = connectTo(host, port, timeoutMs);
	if (fd < 0) return false;

	char lenbuf[32];
	snprintf(lenbuf, sizeof(lenbuf), "%lu", (unsigned long)body.size());
	const std::string request =
		"POST " + path + " HTTP/1.0\r\nHost: " + host +
		"\r\nUser-Agent: TC002-PixelMusic\r\nContent-Type: application/json\r\n"
		"Content-Length: " + lenbuf + "\r\nConnection: close\r\n\r\n" + body;
	if (!sendAll(fd, request)) { close(fd); return false; }

	std::string header;
	char buf[1024];
	int status = -1;
	while (true) {
		ssize_t n = recv(fd, buf, sizeof(buf), 0);
		if (n <= 0) break;
		header.append(buf, (size_t)n);
		std::string::size_type sp = header.find(' ');
		std::string::size_type end = header.find("\r\n");
		if (sp != std::string::npos && end != std::string::npos && end > sp) {
			status = atoi(header.substr(sp + 1, 3).c_str());
			break;
		}
		if (header.size() > 4096) break;
	}
	close(fd);
	return status == 200;
}

}  // namespace pixelnet
