import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startPanel, type PanelSources } from "./addon-panel.js";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

const SECRET = "CANARY-SECRET-KEY-123";
function sources(paired: boolean): PanelSources & { canary: string } {
  return {
    canary: SECRET,
    version: "0.9.0",
    paired: () => paired,
    code: () => ({ code: "K7M2-QX9P", expiresAt: 123 }),
    registration: () => ({ registered: false, error: "401" }),
    pin: () => "set",
    notice: () => (paired ? "never shown once paired" : "An old pairing code is still set."),
    log: () => [{ at: 1, level: "info", text: "Waiting for the Mac: code K7M2-QX9P" }],
  };
}

function get(
  port: number,
  path: string,
  localAddress?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, localAddress }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on("error", reject);
  });
}

describe("addon panel notice", () => {
  it("carries the notice while unpaired, and never once paired", async () => {
    for (const [paired, want] of [
      [false, "An old pairing code is still set."],
      [true, undefined],
    ] as const) {
      const panel = await startPanel(sources(paired), { port: 0, host: "127.0.0.1" });
      stops.push(panel.stop);
      const state = JSON.parse((await get(panel.port, "/api/state")).body) as { notice?: string };
      expect(state.notice).toBe(want);
    }
  });
});

describe("addon panel", () => {
  it("serves state to a local/supervisor address", async () => {
    const p = await startPanel(sources(false), { port: 0, host: "127.0.0.1" });
    stops.push(p.stop);
    const r = await get(p.port, "/api/state");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toEqual({
      version: "0.9.0",
      paired: false,
      code: "K7M2-QX9P",
      codeExpiresAt: 123,
      notice: "An old pairing code is still set.",
      sipRegistered: false,
      sipError: "401",
      pin: "set",
      log: [{ at: 1, level: "info", text: "Waiting for the Mac: code K7M2-QX9P" }],
    });
    expect(r.body).not.toContain(SECRET);
  });

  it("hides the code once paired", async () => {
    const p = await startPanel(sources(true), { port: 0, host: "127.0.0.1" });
    stops.push(p.stop);
    const s = JSON.parse((await get(p.port, "/api/state")).body);
    expect(s.paired).toBe(true);
    expect(s.code).toBeUndefined();
  });

  it("serves a page with no external URL and relative fetches", async () => {
    const p = await startPanel(sources(false), { port: 0, host: "127.0.0.1" });
    stops.push(p.stop);
    const r = await get(p.port, "/");
    expect(r.status).toBe(200);
    expect(r.body).not.toMatch(/https?:\/\//);
    expect(r.body).toContain('fetch("api/state"');
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("opens Home Assistant updates outside the ingress frame, even from an ingress path", async () => {
    const p = await startPanel(sources(false), { port: 0, host: "127.0.0.1" });
    stops.push(p.stop);
    const r = await get(p.port, "/api/hassio_ingress/session/");
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/<a [^>]*href="\/config\/updates"[^>]*target="_top"[^>]*>Open Home Assistant updates<\/a>/);
    // Update navigation requires no browser credentials, Supervisor API proxy or write route.
    expect(r.body).not.toMatch(/SUPERVISOR_TOKEN|window\.parent|fetch\([^)]*store\//);
    expect(r.headers["content-security-policy"]).toContain("connect-src 'self'");
  });

  it("refuses an address that is not the Supervisor", async () => {
    const p = await startPanel(sources(false), { port: 0, host: "0.0.0.0" });
    stops.push(p.stop);
    // Reach it from the machine's other loopback alias so the remote address is not 127.0.0.1.
    const r = await get(p.port, "/api/state", "127.0.0.2").catch(() => null);
    if (r) expect(r.status).toBe(403);
  });
});
