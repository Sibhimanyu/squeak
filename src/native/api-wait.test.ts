import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ApiWaitTracker,
  autoCompactDue,
  autoCompactThreshold,
  chatSize,
  claudeTranscriptBytes,
  classifyConnectionFailure,
  cliCompactWindow,
  failureCardText,
  handoffFallback,
  handoffPrompt,
  stallMsFromEnv,
  waitLabel,
} from "./api-wait.js";

describe("wait status mapping", () => {
  it("sent -> waiting, retry -> retrying (keeps the original start), stream -> cleared", () => {
    const t = new ApiWaitTracker();
    t.requestSent(1000);
    expect(t.state).toEqual({ phase: "waiting", since: 1000 });
    expect(t.observe({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10 }, 5000)).toBe(true);
    expect(t.state).toMatchObject({ phase: "retrying", since: 1000, attempt: 2 });
    expect(t.observe({ type: "stream_event", event: { type: "content_block_start" } }, 6000)).toBe(true);
    expect(t.state).toBeNull();
    expect(t.event(7000)).toEqual({ type: "squeak_phase", phase: "none" });
  });

  it("labels carry minutes only from the first full minute", () => {
    expect(waitLabel({ phase: "waiting", since: 0 }, 30_000)).toBe("Waiting for Claude");
    expect(waitLabel({ phase: "waiting", since: 0 }, 4 * 60_000 + 5000)).toBe("Waiting for Claude · 4m");
    expect(waitLabel({ phase: "retrying", since: 0, attempt: 2 }, 4 * 60_000)).toBe("Retrying Claude (2) · 4m");
  });

  it("the stall minutes come from the environment, 0 turns it off", () => {
    expect(stallMsFromEnv({})).toBe(600_000);
    expect(stallMsFromEnv({ SQUEAK_API_STALL_MIN: "3" })).toBe(180_000);
    expect(stallMsFromEnv({ SQUEAK_API_STALL_MIN: "0" })).toBe(0);
  });
});

describe("connection failures", () => {
  it("recognises dropped, timed out, overloaded, server and stall; not a refusal", () => {
    expect(
      classifyConnectionFailure("API Error: Connection dropped (ECONNRESET). Check the proxy set in https_proxy"),
    ).toBe("dropped");
    expect(classifyConnectionFailure("socket hang up")).toBe("dropped");
    expect(classifyConnectionFailure("Request timed out")).toBe("timeout");
    expect(classifyConnectionFailure("API Error: 529 overloaded_error")).toBe("overloaded");
    expect(classifyConnectionFailure("API Error: 502 Bad Gateway")).toBe("server");
    expect(classifyConnectionFailure("No response from Claude")).toBe("stalled");
    expect(classifyConnectionFailure("Not logged in · Please run /login")).toBeNull();
  });

  it("the card says how long it ran", () => {
    expect(failureCardText("dropped", 15 * 60_000 + 50_000)).toBe(
      "Couldn't reach Claude — connection dropped after 15m",
    );
    expect(failureCardText("dropped", 20_000)).toBe("Couldn't reach Claude — connection dropped after 20s");
  });
});

describe("size threshold", () => {
  const ctx = (used: number, limit = 1_000_000) => ({ used, limit, percent: Math.round((used / limit) * 1000) / 10 });
  it("large above 60% of the window or above 20 MB of transcript", () => {
    expect(chatSize(ctx(660_000), null)).toMatchObject({ large: true, reason: "context" });
    expect(chatSize(ctx(300_000), 45 * 1024 * 1024)).toMatchObject({ large: true, reason: "transcript" });
    expect(chatSize(ctx(300_000), 5 * 1024 * 1024).large).toBe(false);
    expect(chatSize(null, null).large).toBe(false);
  });

  it("reads a transcript's size by session id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    fs.mkdirSync(path.join(dir, "-a-b"));
    const id = "56a10a1a-1111-2222-3333-444444444444";
    fs.writeFileSync(path.join(dir, "-a-b", `${id}.jsonl`), "x".repeat(1234));
    expect(claudeTranscriptBytes(id, dir)).toBe(1234);
    expect(claudeTranscriptBytes("nope", dir)).toBeNull();
  });
});

describe("auto-compaction threshold", () => {
  it("defaults to 200k, honours a setting (min 100k) and 0 = off", () => {
    expect(autoCompactThreshold(null)).toBe(200_000);
    expect(autoCompactThreshold(undefined)).toBe(200_000);
    expect(autoCompactThreshold(350_000)).toBe(350_000);
    expect(autoCompactThreshold(50_000)).toBe(100_000);
    expect(autoCompactThreshold(0)).toBeNull();
  });

  it("is due at or past the threshold, not when off, unknown, or just compacted", () => {
    const c = (used: number) => ({ used, limit: 1_000_000, percent: used / 10_000 });
    const now = 10_000_000;
    expect(autoCompactDue(c(199_999), 200_000, undefined, now)).toBe(false);
    expect(autoCompactDue(c(200_000), 200_000, undefined, now)).toBe(true);
    expect(autoCompactDue(c(660_579), null, undefined, now)).toBe(false);
    expect(autoCompactDue(null, 200_000, undefined, now)).toBe(false);
    expect(autoCompactDue(c(300_000), 200_000, now - 60_000, now)).toBe(false);
    expect(autoCompactDue(c(300_000), 200_000, now - 6 * 60_000, now)).toBe(true);
  });

  it("the CLI is told a window only when it is below the model's own", () => {
    expect(cliCompactWindow(200_000, "claude-opus-5[1m]")).toBe(200_000);
    expect(cliCompactWindow(200_000, "claude-opus-5")).toBeNull();
    expect(cliCompactWindow(null, "claude-opus-5[1m]")).toBeNull();
  });
});

describe("handoff text", () => {
  const rows = [
    { role: "user", text: "Fix the login redirect" },
    { role: "agent", text: "Done, see auth.ts" },
  ];
  it("the prompt names the title and the rows; the fallback keeps the person's words", () => {
    const p = handoffPrompt("Greenroom x Recorditor", rows);
    expect(p).toContain("Greenroom x Recorditor");
    expect(p).toContain("Person: Fix the login redirect");
    expect(handoffFallback("T", rows)).toContain("Fix the login redirect");
  });
});
