import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readSendDefaultRequest, resolveSendMode, SendDefaultStore } from "./send-default.js";

function file(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "send-default-")), "send-default.json");
}

describe("send default", () => {
  it("defaults to steer for someone who never picked, applies one strict change, and persists it", () => {
    const f = file();
    const store = new SendDefaultStore(f);
    expect(store.mode).toBe("steer");
    expect(store.apply({ mode: "queue" })).toEqual({ ok: true, mode: "queue" });
    expect(new SendDefaultStore(f).mode).toBe("queue");
  });

  it("keeps an explicit choice of either mode across a restart", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ mode: "queue" }));
    expect(new SendDefaultStore(f).mode).toBe("queue");
    fs.writeFileSync(f, JSON.stringify({ mode: "steer" }));
    expect(new SendDefaultStore(f).mode).toBe("steer");
  });

  it("refuses anything but exactly { mode: queue | steer }", () => {
    const store = new SendDefaultStore(file());
    for (const bad of [null, [], "steer", {}, { mode: "interrupt" }, { mode: "steer", extra: 1 }, { other: "steer" }]) {
      expect(readSendDefaultRequest(bad)).toBeNull();
      expect(store.apply(bad).ok).toBe(false);
    }
    expect(store.mode).toBe("steer");
  });

  it("reads a damaged file as the default (steer)", () => {
    const f = file();
    fs.writeFileSync(f, "{nope");
    expect(new SendDefaultStore(f).mode).toBe("steer");
  });

  it("applies the default only when the send names no mode", () => {
    expect(resolveSendMode(undefined, "steer")).toBe("steer");
    expect(resolveSendMode("queue", "steer")).toBe("queue");
    expect(resolveSendMode("steer", "queue")).toBe("steer");
    expect(resolveSendMode(undefined, undefined)).toBe("steer");
  });
});
