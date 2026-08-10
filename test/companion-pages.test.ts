import { describe, expect, test } from "bun:test";
import { createControlHandler } from "../src/control-api.ts";
import type { DashboardController } from "../src/controller.ts";
import { drawPageHtml, padPageHtml } from "../src/web-ui.ts";

const controller = {} as DashboardController;

// /pad and /draw are the QR-scan companion pages: self-contained inline HTML
// with zero build products, talking only to the same-origin WebSocket relay.

function inlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("companion pages", () => {
  test("serves /pad and /draw with a strict inline-only CSP", async () => {
    const handler = createControlHandler(controller);
    for (const path of ["/pad", "/draw"]) {
      const response = await handler(new Request(`http://clock.test:43820${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'unsafe-inline'");
      // The page must be allowed to reach the same-origin WebSocket relay.
      expect(csp).toContain("connect-src 'self' ws: wss:");
      const html = await response.text();
      expect(html).toContain("<script>");
      expect(html).not.toContain("src=");
    }
  });

  test("pad page wires the touch strip to the relay protocol", () => {
    const html = padPageHtml();
    expect(html).toContain("/api/game/socket?room=");
    expect(html).toContain("role=pad");
    // Input protocol (§6): {type:"input", y:0..1}, sent only on change.
    const script = inlineScript(html);
    expect(script).toContain('type: "input"');
    expect(script).toContain("y === sentY");
    // The inline script must at least be valid JavaScript.
    expect(() => new Function(script)).not.toThrow();
  });

  test("draw page carries the studio palette and the stroke protocol", () => {
    const html = drawPageHtml();
    expect(html).toContain("room=draw&role=pad");
    expect(html).toContain('width="52" height="16"');
    const script = inlineScript(html);
    // Stroke protocol (§7): {type:"stroke", x, y, color|null}.
    expect(script).toContain('type: "stroke"');
    expect(script).toContain("eraser ? null : value");
    expect(script).toContain('"snapshot"');
    // 12 palette entries, mirroring the studio board's swatches.
    expect(script).toContain("0x00ff66");
    expect(script.match(/0x[0-9a-f]{6}/g)?.length).toBe(12);
    expect(() => new Function(script)).not.toThrow();
  });
});
