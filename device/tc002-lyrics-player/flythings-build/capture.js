const { chromium } = require("playwright-core");

const EXEC = process.env.CH;
const TARGET = process.env.URL || "https://package.flythings.cn/Z21/easyui/2.6.0";

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const page = await browser.newPage();
  const reqs = new Set();
  const jsons = [];

  page.on("request", (req) => {
    const u = req.url();
    const t = req.resourceType();
    if (t === "xhr" || t === "fetch" || /\/api\/|download|\.zip|\.tar|\.tgz|artifact/i.test(u)) {
      reqs.add(`${req.method()} ${u}`);
    }
  });
  page.on("response", async (resp) => {
    const u = resp.url();
    const ct = resp.headers()["content-type"] || "";
    if (ct.includes("json") && !/\.js($|\?)/.test(u)) {
      try {
        const body = await resp.text();
        jsons.push(`${u}\n${body.slice(0, 700)}`);
      } catch {}
    }
  });

  try {
    await page.goto(TARGET, { waitUntil: "networkidle", timeout: 35000 });
  } catch (e) {
    console.log("goto warning:", e.message);
  }
  await page.waitForTimeout(2500);

  console.log("=== XHR/fetch/download requests ===");
  console.log([...reqs].join("\n") || "(none)");
  console.log("\n=== JSON responses ===");
  console.log(jsons.join("\n---\n") || "(none)");

  const links = await page.$$eval("a", (as) =>
    as.map((a) => a.href).filter((h) => /\.zip|\.tar|\.tgz|download|artifact/i.test(h))
  );
  console.log("\n=== download-like anchors ===");
  console.log([...new Set(links)].join("\n") || "(none)");

  await browser.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
