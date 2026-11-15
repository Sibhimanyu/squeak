import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeStore } from "../native/store.js";
import { NativePhone } from "./native-phone.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(fetchImpl?: typeof fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-phone-hist-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "token"), "tok\n");
  const dbPath = path.join(dir, "native.db");
  const store = new NativeStore(dbPath);
  const session = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
  const phone = new NativePhone({
    dbPath,
    baseUrl: "http://h",
    tokenPath: path.join(dir, "token"),
    models: () => [],
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { store, session, phone };
}

describe("NativePhone.history", () => {
  it("returns the person's prompts and the agent's words in order, skipping tool rows", () => {
    const { store, session, phone } = setup();
    store.appendMessage(session.id, "user", "user/text", { text: "first prompt" });
    store.appendMessage(session.id, "agent", "assistant", {
      message: { content: [{ type: "text", text: "first answer" }] },
    });
    store.appendMessage(session.id, "agent", "assistant", {
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    store.appendMessage(session.id, "user", "user/text", { text: "second prompt with /tmp/pic.png" });
    store.appendMessage(session.id, "agent", "item/agentMessage", { text: "second answer" });
    const page = phone.history(session.id, 50);
    expect(page.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "first prompt"],
      ["assistant", "first answer"],
      ["user", "second prompt with /tmp/pic.png"],
      ["assistant", "second answer"],
    ]);
    expect(page.messages.every((m) => /^\d+$/.test(m.cursor ?? ""))).toBe(true);
    expect(page.complete).toBe(true);
    expect(page.nextBefore).toBeNull();
  });

  it("pages backward by cursor with the oldest cursor as the next before", () => {
    const { store, session, phone } = setup();
    for (let i = 1; i <= 5; i++) store.appendMessage(session.id, "user", "user/text", { text: `p${i}` });
    const newest = phone.history(session.id, 2);
    expect(newest.messages.map((m) => m.text)).toEqual(["p4", "p5"]);
    expect(newest.complete).toBe(false);
    const older = phone.history(session.id, 2, Number(newest.nextBefore));
    expect(older.messages.map((m) => m.text)).toEqual(["p2", "p3"]);
    const oldest = phone.history(session.id, 2, Number(older.nextBefore));
    expect(oldest.messages.map((m) => m.text)).toEqual(["p1"]);
    expect(oldest.nextBefore).toBeNull();
  });

  it("is empty, not a throw, for a missing database", () => {
    const phone = new NativePhone({
      dbPath: "/nonexistent/native.db",
      baseUrl: "http://h",
      tokenPath: "/x",
      models: () => [],
    });
    expect(phone.history("x", 10).messages).toEqual([]);
  });
});

describe("NativePhone.queue", () => {
  it("lists the host's pending items in order with their author, and null when the host cannot say", async () => {
    const { phone } = setup(
      (async () =>
        new Response(
          JSON.stringify({
            pending: [
              { id: "a", text: "one", state: "queued", createdAt: "1" },
              { id: "b", text: "two", state: "steering", createdAt: "2", author: { id: "u", name: "Ada" } },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    expect(await phone.queue("s")).toEqual([
      { id: "a", text: "one", mode: "queue", position: 1 },
      { id: "b", text: "two", mode: "steer", position: 2, author: "Ada" },
    ]);
    const down = setup((async () => {
      throw new Error("down");
    }) as unknown as typeof fetch).phone;
    expect(await down.queue("s")).toBeNull();
  });
});
