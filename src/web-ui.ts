// The /pad and /draw pages are deliberately served as standalone inline-script
// HTML instead of the studio bundle: a phone that scans a QR code should get an
// interactive control in one tiny request, with zero build products involved.
// Both connect to the same /api/game/socket relay (pixel-playground.md §6/§7).

export function padPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#05070d">
  <title>Pong 手柄 · Pixel Market</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; }
    body {
      display: flex; flex-direction: column; gap: 10px;
      padding: calc(10px + env(safe-area-inset-top)) 14px calc(12px + env(safe-area-inset-bottom));
      background: #05070d; color: #e8edf6; overscroll-behavior: none;
      font-family: ui-sans-serif, system-ui, "PingFang SC", "Noto Sans SC", sans-serif;
      user-select: none; -webkit-user-select: none; touch-action: none;
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    header h1 { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
    header h1 span { margin-left: 6px; color: #ff8a2a; font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.14em; }
    #status { display: inline-flex; align-items: center; gap: 6px; color: #93a1b4; font-size: 12px; }
    #status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #93a1b4; }
    body.is-online #status { color: #7ee2a0; } body.is-online #status::before { background: #35c463; }
    body.is-lost #status { color: #ff9a6b; } body.is-lost #status::before { background: #ff6b3d; }
    #strip {
      position: relative; flex: 1; overflow: hidden; border: 1px solid #1d2836; border-radius: 18px;
      background: linear-gradient(180deg, #0a101c 0%, #0d1524 50%, #0a101c 100%); cursor: grab;
    }
    #strip::before {
      content: ""; position: absolute; inset: 0 calc(50% - 1px);
      background: repeating-linear-gradient(180deg, #22304a 0 10px, transparent 10px 22px);
    }
    #knob {
      position: absolute; left: 10%; width: 80%; height: 64px; margin-top: -32px; top: 50%;
      border-radius: 14px; background: linear-gradient(180deg, #ff8a2a, #f06414);
      box-shadow: 0 0 26px rgba(255, 138, 42, 0.45); transition: top 40ms linear;
    }
    #knob::after {
      content: ""; position: absolute; inset: 26px 34%; border-radius: 6px; background: rgba(9, 5, 2, 0.35);
    }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #6f8296; font-size: 12px; }
    #match { color: #b9c6d8; font-variant-numeric: tabular-nums; }
    #fatal { display: none; margin: auto; max-width: 30ch; color: #ff9a6b; font-size: 15px; line-height: 1.7; text-align: center; }
    body.is-fatal #fatal { display: block; }
    body.is-fatal header, body.is-fatal #strip, body.is-fatal footer { display: none; }
  </style>
</head>
<body>
  <header>
    <h1>P2 手柄<span id="room"></span></h1>
    <span id="status">连接中…</span>
  </header>
  <div id="strip" aria-label="上下拖动控制右侧挡板"><div id="knob"></div></div>
  <footer><span>上下拖动控制右侧挡板</span><span id="match"></span></footer>
  <p id="fatal">链接缺少房间号。请回到游戏页，点「邀请手柄」重新扫码。</p>
  <script>
  (function () {
    "use strict";
    var room = (new URLSearchParams(location.search).get("room") || "").toLowerCase();
    if (!/^[a-z0-9]{4}$/.test(room)) { document.body.classList.add("is-fatal"); return; }
    document.getElementById("room").textContent = room.toUpperCase();

    var statusEl = document.getElementById("status");
    var matchEl = document.getElementById("match");
    var strip = document.getElementById("strip");
    var knob = document.getElementById("knob");
    var PHASES = { ready: "等待发球", playing: "对战中", "game-over": "本局结束" };

    var ws = null;
    var hostOnline = false;
    var y = 0.5;         // latest touch position, 0..1
    var sentY = null;    // last value that actually went out

    function setStatus(text, mode) {
      statusEl.textContent = text;
      document.body.classList.toggle("is-online", mode === "online");
      document.body.classList.toggle("is-lost", mode === "lost");
    }

    function connect() {
      var scheme = location.protocol === "https:" ? "wss://" : "ws://";
      ws = new WebSocket(scheme + location.host + "/api/game/socket?room=" + room + "&role=pad");
      setStatus("连接中…", "idle");
      ws.onopen = function () {
        sentY = null; // resend the current position to the fresh host
        setStatus(hostOnline ? "主机在线" : "已连接，等待主机", "online");
      };
      ws.onclose = function () {
        ws = null;
        hostOnline = false;
        setStatus("连接断开，重连中…", "lost");
        setTimeout(connect, 1500);
      };
      ws.onmessage = function (event) {
        var message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (!message || typeof message !== "object") return;
        if (message.type === "peers") {
          hostOnline = message.host === true;
          setStatus(hostOnline ? "主机在线" : "已连接，等待主机", "online");
        } else if (message.type === "state") {
          var phase = PHASES[message.phase] || "";
          var score = typeof message.score === "number" ? " · 主机 " + message.score + " 分" : "";
          matchEl.textContent = phase + score;
        }
      };
    }

    // ~30Hz input pump: send only when the position moved, so an idle thumb
    // costs no traffic and the 10-minute room recycle works as designed.
    setInterval(function () {
      if (!ws || ws.readyState !== 1 || y === sentY) return;
      ws.send(JSON.stringify({ type: "input", y: y }));
      sentY = y;
    }, 33);

    function track(event) {
      var bounds = strip.getBoundingClientRect();
      var next = (event.clientY - bounds.top) / Math.max(1, bounds.height);
      y = Math.min(1, Math.max(0, next));
      knob.style.top = (y * 100).toFixed(2) + "%";
    }
    strip.addEventListener("pointerdown", function (event) {
      strip.setPointerCapture(event.pointerId);
      track(event);
      if (navigator.wakeLock && !document.hidden) {
        navigator.wakeLock.request("screen").catch(function () {});
      }
    });
    strip.addEventListener("pointermove", function (event) {
      if (strip.hasPointerCapture(event.pointerId)) track(event);
    });
    document.addEventListener("touchmove", function (event) { event.preventDefault(); }, { passive: false });

    connect();
  })();
  </script>
</body>
</html>`;
}

export function drawPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#05070d">
  <title>涂鸦墙 · Pixel Market</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; }
    body {
      display: flex; flex-direction: column; gap: 12px;
      padding: calc(10px + env(safe-area-inset-top)) 14px calc(12px + env(safe-area-inset-bottom));
      background: #05070d; color: #e8edf6; overscroll-behavior: none;
      font-family: ui-sans-serif, system-ui, "PingFang SC", "Noto Sans SC", sans-serif;
      user-select: none; -webkit-user-select: none; touch-action: none;
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    header h1 { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
    #status { display: inline-flex; align-items: center; gap: 6px; color: #93a1b4; font-size: 12px; }
    #status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #93a1b4; }
    body.is-online #status { color: #7ee2a0; } body.is-online #status::before { background: #35c463; }
    body.is-lost #status { color: #ff9a6b; } body.is-lost #status::before { background: #ff6b3d; }
    main { display: grid; flex: 1; place-items: center; min-height: 0; }
    #wall {
      width: min(100%, 92vh * 3.25); aspect-ratio: 52 / 16;
      border: 1px solid #1d2836; border-radius: 10px; background: #000;
      image-rendering: pixelated; cursor: crosshair;
    }
    #palette { display: grid; grid-template-columns: repeat(13, 1fr); gap: 8px; }
    #palette button {
      aspect-ratio: 1; border: 2px solid #1d2836; border-radius: 9px; background: #0a101c;
      color: #93a1b4; font-size: 11px; line-height: 1;
    }
    #palette button.is-active { border-color: #e8edf6; box-shadow: 0 0 0 2px rgba(232, 237, 246, 0.25); }
    footer { color: #6f8296; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>52 × 16 涂鸦墙</h1>
    <span id="status">连接中…</span>
  </header>
  <main><canvas id="wall" width="52" height="16" aria-label="共享像素涂鸦画布"></canvas></main>
  <div id="palette" aria-label="调色板"></div>
  <footer>画的每一笔都会同步到所有人和时钟屏幕</footer>
  <script>
  (function () {
    "use strict";
    var WIDTH = 52, HEIGHT = 16;
    // Same 12 swatches as the studio canvas board, so shared art stays coherent.
    var COLORS = [0xffffff, 0x00ff66, 0xff3030, 0xffd000, 0x4285f4, 0xf25022,
      0x34a853, 0x00a4ef, 0x9aa0a6, 0xea4335, 0xffb900, 0x000000];
    var canvas = document.getElementById("wall");
    var context = canvas.getContext("2d");
    var statusEl = document.getElementById("status");
    var palette = document.getElementById("palette");
    var pixels = new Array(WIDTH * HEIGHT).fill(0);
    var color = COLORS[1];   // studio default: green
    var eraser = false;
    var ws = null;

    function hex(value) { return "#" + ("00000" + value.toString(16)).slice(-6); }

    function paint(x, y, value) {
      pixels[y * WIDTH + x] = value;
      context.fillStyle = hex(value);
      context.fillRect(x, y, 1, 1);
    }

    function repaint() {
      for (var y = 0; y < HEIGHT; y += 1) {
        for (var x = 0; x < WIDTH; x += 1) {
          context.fillStyle = hex(pixels[y * WIDTH + x] || 0);
          context.fillRect(x, y, 1, 1);
        }
      }
    }
    repaint();

    COLORS.forEach(function (value) {
      var swatch = document.createElement("button");
      swatch.type = "button";
      swatch.style.background = hex(value);
      swatch.setAttribute("aria-label", "颜色 " + hex(value));
      if (value === color) swatch.classList.add("is-active");
      swatch.addEventListener("click", function () { color = value; eraser = false; markActive(swatch); });
      palette.appendChild(swatch);
    });
    var eraserButton = document.createElement("button");
    eraserButton.type = "button";
    eraserButton.textContent = "擦";
    eraserButton.setAttribute("aria-label", "橡皮");
    eraserButton.addEventListener("click", function () { eraser = true; markActive(eraserButton); });
    palette.appendChild(eraserButton);
    function markActive(button) {
      for (var i = 0; i < palette.children.length; i += 1) palette.children[i].classList.remove("is-active");
      button.classList.add("is-active");
    }

    function setStatus(text, mode) {
      statusEl.textContent = text;
      document.body.classList.toggle("is-online", mode === "online");
      document.body.classList.toggle("is-lost", mode === "lost");
    }

    function connect() {
      var scheme = location.protocol === "https:" ? "wss://" : "ws://";
      ws = new WebSocket(scheme + location.host + "/api/game/socket?room=draw&role=pad");
      setStatus("连接中…", "idle");
      ws.onopen = function () { setStatus("已连接", "online"); };
      ws.onclose = function () {
        ws = null;
        setStatus("连接断开，重连中…", "lost");
        setTimeout(connect, 1500);
      };
      ws.onmessage = function (event) {
        var message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (!message || typeof message !== "object") return;
        if (message.type === "snapshot" && Array.isArray(message.pixels) && message.pixels.length === WIDTH * HEIGHT) {
          pixels = message.pixels.map(function (value) {
            return typeof value === "number" ? value : 0;
          });
          repaint();
        } else if (message.type === "stroke"
          && typeof message.x === "number" && typeof message.y === "number") {
          paint(message.x, message.y, typeof message.color === "number" ? message.color : 0);
        } else if (message.type === "peers" && typeof message.count === "number") {
          setStatus(message.count > 1 ? "已连接 · " + message.count + " 人在线" : "已连接", "online");
        }
      };
    }

    function drawAt(event) {
      var bounds = canvas.getBoundingClientRect();
      var x = Math.floor((event.clientX - bounds.left) / bounds.width * WIDTH);
      var y = Math.floor((event.clientY - bounds.top) / bounds.height * HEIGHT);
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      var value = eraser ? 0 : color;
      if (pixels[y * WIDTH + x] === value) return;
      paint(x, y, value);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "stroke", x: x, y: y, color: eraser ? null : value }));
      }
    }
    canvas.addEventListener("pointerdown", function (event) {
      canvas.setPointerCapture(event.pointerId);
      drawAt(event);
    });
    canvas.addEventListener("pointermove", function (event) {
      if (canvas.hasPointerCapture(event.pointerId)) drawAt(event);
    });
    document.addEventListener("touchmove", function (event) { event.preventDefault(); }, { passive: false });

    connect();
  })();
  </script>
</body>
</html>`;
}

export function controlPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN" class="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f2">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Pixel Market">
  <meta name="description" content="Ulanzi TC002 多频道内容工作台">
  <title>Pixel Market · Ulanzi TC002</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/assets/studio.css">
</head>
<body>
  <div id="root">
    <noscript>请启用 JavaScript 以使用 Pixel Market。</noscript>
  </div>
  <script type="module" src="/assets/studio.js"></script>
</body>
</html>`;
}
