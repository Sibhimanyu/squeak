import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CallHistory } from "./call-history.js";
import { CallTrace, MAC_RING } from "./call-trace.js";
import type { GatewayLogLine } from "./gateway-log-protocol.js";

const dirs: string[] = [];
function dir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const line = (at: number, text: string, level: "info" | "warn" = "info"): GatewayLogLine => ({ at, level, text });

describe("CallTrace", () => {
  it("parses the line grammar and ignores a repeat", () => {
    const trace = new CallTrace(dir(), () => 0);
    const lines = [
      line(1000, "said: hello there"),
      line(1100, "key: 1 (send)"),
      line(1200, "step: Recorded 3.0 s"),
      line(1300, "Call placed to extension 101"),
      line(1400, "Call failed: no route", "warn"),
    ];
    expect(trace.ingestGateway(lines)).toBe(5);
    expect(trace.ingestGateway(lines)).toBe(0);
    expect(trace.eventsFor({ at: 1000, durationMs: 0 })).toEqual([
      { at: 1000, source: "add-on", kind: "said", text: "hello there" },
      { at: 1100, source: "add-on", kind: "key", text: "1 (send)" },
      { at: 1200, source: "add-on", kind: "step", text: "Recorded 3.0 s" },
      { at: 1300, source: "add-on", kind: "step", text: "Call placed to extension 101" },
      { at: 1400, source: "add-on", kind: "warn", text: "Call failed: no route" },
    ]);
  });

  it("persists both rings (0600) and bounds the Mac ring", () => {
    const d = dir();
    let t = 0;
    const trace = new CallTrace(d, () => ++t);
    for (let i = 0; i < MAC_RING + 10; i++) trace.mac("step", `s${i}`, i === 0 ? { label: "x", ms: 5 } : {});
    trace.ingestGateway([line(5, "said: hi")]);
    expect(fs.statSync(path.join(d, "voice-call-events.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(d, "voice-gateway-events.json")).mode & 0o777).toBe(0o600);
    const again = new CallTrace(d, () => 0);
    expect(again.ingestGateway([line(5, "said: hi")])).toBe(0);
    const all = again.eventsFor({ at: 0, durationMs: 100_000 });
    expect(all.filter((e) => e.source === "mac").length).toBe(0 + 80 - all.filter((e) => e.source !== "mac").length);
  });

  it("windows events around a call, merges sources sorted, caps at 80, hides labels", () => {
    const trace = new CallTrace(dir(), () => 10_000);
    trace.mac("step", "Call placed", { label: "repo · chat" });
    trace.ingestGateway([line(8_000, "said: early"), line(9_000, "key: 2 chosen"), line(99_000, "step: far")]);
    const events = trace.eventsFor({ at: 10_000, durationMs: 1000 });
    expect(events.map((e) => e.text)).toEqual(["early", "2 chosen", "Call placed"]);
    expect(events.every((e) => !("label" in e))).toBe(true);
    const many = new CallTrace(dir(), () => 10_000);
    for (let i = 0; i < 120; i++) many.mac("step", `s${i}`);
    expect(many.eventsFor({ at: 10_000, durationMs: 0 })).toHaveLength(80);
  });

  it("derives an answered incoming call once, with outcome, sent, label and duration", () => {
    let now = 1_000_000;
    const trace = new CallTrace(dir(), () => now);
    const history = new CallHistory(path.join(dir(), "c.json"));
    trace.ingestGateway([
      line(100_000, "step: Call in answered from extension 35210"),
      line(103_000, "said: Which chat?"),
      line(106_000, "key: 1 (send)"),
      line(107_000, "step: Recorded 4.0 s"),
      line(108_000, "step: Message sent"),
      line(110_000, "step: Call in ended after 10.0 s"),
    ]);
    now = 100_500;
    trace.mac("step", "Chat chosen", { label: "squeak · fix" });
    now = 115_000;
    expect(trace.deriveIncoming(history)).toBe(0); // window still open
    now = 1_000_000;
    expect(trace.deriveIncoming(history)).toBe(1);
    expect(trace.deriveIncoming(history)).toBe(0);
    expect(history.list()[0]).toMatchObject({
      id: "in-100000",
      kind: "incoming",
      outcome: "answered",
      sent: true,
      durationMs: 10_000,
      label: "squeak · fix",
    });
  });

  it("derives refused and unanswered incoming calls", () => {
    const trace = new CallTrace(dir(), () => 2_000_000);
    const history = new CallHistory(path.join(dir(), "c.json"));
    trace.ingestGateway([
      line(10_000, "step: Call in from extension 999 refused: not the allowed extension"),
      line(50_000, "step: Call in answered from extension 101"),
      line(55_000, "step: PIN wrong"),
      line(56_000, "step: Call in ended after 6.0 s"),
    ]);
    expect(trace.deriveIncoming(history)).toBe(2);
    const calls = history.list();
    expect(calls.find((c) => c.at === 10_000)).toMatchObject({
      outcome: "failed",
      failure: "not the allowed extension",
    });
    expect(calls.find((c) => c.at === 50_000)).toMatchObject({ outcome: "unanswered", durationMs: 6000 });
  });
});
