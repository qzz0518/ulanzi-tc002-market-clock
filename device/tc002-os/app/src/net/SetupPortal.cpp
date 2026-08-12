#include "net/SetupPortal.h"

#include <stdio.h>

namespace tcos {

namespace {

// Inlined on purpose: the phone is joined to the device's own hotspot and has
// no route to the internet, so a CDN stylesheet or web font would leave the
// setup screen spinning with nothing to explain why.
const char* kPageHtml =
    "<!doctype html><html lang=zh><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>TC002 OS 配网</title><style>"
    "*{box-sizing:border-box}"
    "body{margin:0;padding:24px 18px;background:#0d100e;color:#e8f0ea;"
    "font:16px/1.5 -apple-system,system-ui,sans-serif}"
    "h1{margin:0 0 4px;font-size:20px}"
    "p.sub{margin:0 0 22px;color:#8fa396;font-size:13px}"
    "label{display:block;margin:16px 0 6px;font-size:13px;color:#8fa396}"
    "select,input{width:100%;padding:12px;border-radius:10px;border:1px solid #27352b;"
    "background:#141a16;color:#e8f0ea;font-size:16px}"
    "button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:10px;"
    "background:#00c46a;color:#04150c;font-size:16px;font-weight:600}"
    "button:disabled{opacity:.5}"
    "#msg{margin-top:16px;padding:12px;border-radius:10px;background:#141a16;"
    "font-size:14px;display:none}"
    "</style></head><body>"
    "<h1>连接 Wi-Fi</h1>"
    "<p class=sub>仅支持 2.4G 网络</p>"
    "<label for=s>网络</label><select id=s></select>"
    "<label for=m>找不到？手动输入名称</label><input id=m autocomplete=off "
    "autocapitalize=off autocorrect=off spellcheck=false>"
    "<label for=p>密码</label><input id=p type=password autocomplete=off>"
    "<button id=b onclick=go()>连接</button>"
    "<div id=msg></div>"
    "<script>"
    "function show(t){var m=document.getElementById('msg');m.style.display='block';m.textContent=t}"
    "function load(){fetch('/scan').then(r=>r.json()).then(d=>{"
    "var s=document.getElementById('s');s.innerHTML='';"
    "if(!d.networks.length){var o=document.createElement('option');"
    "o.value='';o.textContent='未发现网络';s.appendChild(o);setTimeout(load,2000);return}"
    "d.networks.forEach(function(n){var o=document.createElement('option');"
    "o.value=n;o.textContent=n;s.appendChild(o)})})}"
    "function go(){var b=document.getElementById('b');"
    "var ssid=document.getElementById('m').value.trim()||document.getElementById('s').value;"
    "if(!ssid){show('请选择网络，或手动输入名称。');return}"
    "b.disabled=true;show('正在连接…');"
    "fetch('/connect',{method:'POST',headers:{'Content-Type':"
    "'application/x-www-form-urlencoded'},body:'ssid='+encodeURIComponent(ssid)"
    "+'&password='+encodeURIComponent("
    "document.getElementById('p').value)}).then(function(r){"
    "if(!r.ok){b.disabled=false;r.json().then(function(j){"
    "show('设备拒绝了这次请求：'+(j.reason||r.status))}).catch(function(){"
    "show('设备拒绝了这次请求（'+r.status+'）。')});return}poll()})}"
    "function poll(){fetch('/status').then(r=>r.json()).then(function(d){"
    "if(d.status=='online'){show('已连接，设备地址 '+d.ip+'。可以关闭本页。');return}"
    "if(d.status=='failed'){show('连接失败，请检查名称和密码后重试。');"
    "document.getElementById('b').disabled=false;return}"
    "setTimeout(poll,1500)})}"
    "load()</script></body></html>";

}  // namespace

SetupPortal::SetupPortal(Backend* backend) : mBackend(backend) {}

std::string SetupPortal::jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (size_t i = 0; i < value.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(value[i]);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          // A control byte in an SSID would otherwise produce invalid JSON and
          // leave the page stuck on "正在扫描…" with no clue why.
          char buffer[8];
          ::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
          out += buffer;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

std::string SetupPortal::htmlEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  for (size_t i = 0; i < value.size(); ++i) {
    switch (value[i]) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += value[i];
    }
  }
  return out;
}

HttpServer::Response SetupPortal::page() const {
  HttpServer::Response r;
  r.contentType = "text/html; charset=utf-8";
  r.body = kPageHtml;
  return r;
}

HttpServer::Response SetupPortal::scan() const {
  HttpServer::Response r;
  r.contentType = "application/json";
  std::string body = "{\"networks\":[";
  if (mBackend != 0) {
    const std::vector<std::string> networks = mBackend->scanResults();
    for (size_t i = 0; i < networks.size(); ++i) {
      if (i > 0) body += ",";
      body += "\"";
      body += jsonEscape(networks[i]);
      body += "\"";
    }
  }
  body += "]}";
  r.body = body;
  return r;
}

HttpServer::Response SetupPortal::status() const {
  HttpServer::Response r;
  r.contentType = "application/json";
  std::string state = "provisioning";
  std::string ip;
  if (mBackend != 0) {
    state = mBackend->status();
    ip = mBackend->ipAddress();
  }
  r.body = "{\"status\":\"" + jsonEscape(state) + "\",\"ip\":\"" + jsonEscape(ip) + "\"}";
  return r;
}

HttpServer::Response SetupPortal::connect(const std::string& body) {
  HttpServer::Response r;
  r.contentType = "application/json";
  const std::string ssid = HttpServer::formValue(body, "ssid");
  const std::string psk = HttpServer::formValue(body, "password");
  if (ssid.empty()) {
    r.status = 400;
    r.body = "{\"error\":\"ssid required\"}";
    return r;
  }
  // An open network is legitimate, so an empty password is accepted; only a
  // missing SSID is an error.
  std::string reason;
  const bool accepted = mBackend == 0 ? false : mBackend->submit(ssid, psk, &reason);
  if (!accepted) {
    // 409 rather than 200-with-an-error-field: the phone's fetch() sees the
    // failure without having to parse the body, and a refusal is a state
    // conflict, not a malformed request.
    r.status = 409;
    r.body = "{\"ok\":false,\"reason\":\"" + jsonEscape(reason) + "\"}";
    return r;
  }
  r.body = "{\"ok\":true}";
  return r;
}

HttpServer::Response SetupPortal::handle(const HttpServer::Request& request) {
  if (request.path == "/scan") return scan();
  if (request.path == "/status") return status();
  if (request.path == "/connect") {
    if (request.method != "POST") {
      HttpServer::Response r;
      r.status = 400;
      r.body = "POST required";
      return r;
    }
    return connect(request.body);
  }
  // Everything else serves the page. A phone's captive-portal probe hits an
  // arbitrary path, and answering it with the setup form is what makes the
  // "sign in to network" banner open straight onto this page.
  return page();
}

}  // namespace tcos
