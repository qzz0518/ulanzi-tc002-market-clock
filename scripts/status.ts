import { loadHealthPort } from "../src/config.ts";

const healthPort = loadHealthPort();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3_000);

try {
  const response = await fetch(`http://127.0.0.1:${healthPort}/health`, {
    signal: controller.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`Market clock service is not available: ${message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
