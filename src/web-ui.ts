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
