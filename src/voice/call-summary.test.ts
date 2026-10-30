import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultNotifySettings } from "../fleet/notify-settings.js";
import {
  answeredSummary,
  callNoteAllowed,
  callSentText,
  clipWords,
  parseSentNote,
  sentSummary,
} from "./call-summary.js";
import { CallTrace } from "./call-trace.js";
import { CallHistory } from "./call-history.js";

describe("call summaries", () => {
  it("names the option that was pressed", () => {
    const options = [
      { letter: "A", title: "Yes, both: ship everything" },
      { letter: "B", title: "Only the daemon" },
    ];
    expect(answeredSummary(options, "A")).toBe("Answered: option 1 (Yes, both)");
    expect(answeredSummary(options, "b")).toBe("Answered: option 2 (Only the daemon)");
    expect(answeredSummary(options, "Z")).toBeNull();
  });

  it("summarises a sent message, clipped at a word", () => {
    expect(sentSummary("App quitting loop", "check the loop")).toBe("Sent “check the loop” to App quitting loop");
    const long = sentSummary("A chat", "word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toContain("…”");
  });

  it("clips words without cutting mid-word", () => {
    expect(clipWords("alpha beta gamma", 8)).toBe("alpha…");
    expect(clipWords("alpha beta", 10)).toBe("alpha beta");
  });

  it("rewrites the inbox's note as one short call text", () => {
    const parsed = parseSentNote("Sent by phone to App loop: “fix it\nnow”");
    expect(parsed).toEqual({ label: "App loop", message: "fix it\nnow" });
    expect(callSentText(parsed!.label, parsed!.message)).toBe("Call: sent your message to App loop: “fix it now”");
    expect(callSentText("X", "y ".repeat(100)).length).toBeLessThan(120);
    expect(parseSentNote("The message you phoned in did not go through")).toBeNull();
  });

  it("holds the call text for a muted channel and in quiet hours", () => {
    const channel = defaultNotifySettings().telegram;
    const noon = new Date("2026-10-28T12:00:00");
    expect(callNoteAllowed(channel, noon)).toBe(true);
    expect(callNoteAllowed({ ...channel, muted: true }, noon)).toBe(false);
    expect(
      callNoteAllowed({ ...channel, quiet: { from: "22:00", to: "07:00" } }, new Date("2026-10-28T23:00:00")),
    ).toBe(false);
  });

  it("puts the sent message into a call-in's history entry, and none when nothing was sent", () => {
    let now = 100_500;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-"));
    const trace = new CallTrace(root, () => now);
    const history = new CallHistory(path.join(root, "c.json"));
    const line = (at: number, text: string) => ({ at, level: "info" as const, text });
    trace.ingestGateway([
      line(100_000, "step: Call in answered from extension 35210"),
      line(110_000, "step: Call in ended after 10.0 s"),
    ]);
    trace.mac("heard", "check the quitting loop", { label: "App quitting loop" });
    trace.mac("step", "Message sent");
    now = 1_000_000;
    trace.deriveIncoming(history);
    expect(history.list()[0]?.summary).toBe("Sent “check the quitting loop” to App quitting loop");
  });
});
