import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AutoTitler, cleanTitle, heuristicTitle, titleModel, titlePrompt } from "./auto-title.js";
import { NativeStore } from "./store.js";

function makeStore(): NativeStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-title-"));
  return new NativeStore(path.join(dir, "native.db"));
}

function chat(store: NativeStore, text: string | null, title?: string): string {
  const s = store.createSession({ cwd: os.tmpdir(), agent: "claude", model: "m", permissionMode: "default" });
  if (text) store.appendMessage(s.id, "user", "user/text", { text });
  if (title) store.setTitle(s.id, title);
  return s.id;
}

describe("cleanTitle", () => {
  it("strips quotes, markdown and trailing punctuation", () => {
    expect(cleanTitle('"Merge branches and clean repo."')).toBe("Merge branches and clean repo");
    expect(cleanTitle("**Title:** Greenroom x Recorditor!\nextra line")).toBe("Greenroom x Recorditor");
    expect(cleanTitle("  `Fix   login`  ")).toBe("Fix login");
  });
  it("rejects empty and long answers, clips at a word", () => {
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("one two three four five six seven eight nine")).toBeNull();
    const t = cleanTitle("Internationalisation infrastructure modernisation roadmap proposal");
    expect(t!.length).toBeLessThanOrEqual(48);
    expect(t!.endsWith(" ")).toBe(false);
  });
});

describe("heuristicTitle", () => {
  it("drops filler and keeps six words, Title Case", () => {
    expect(heuristicTitle("We need to merge everything we have and clean up the repo")).toBe(
      "Merge Everything We Have and Clean",
    );
    expect(heuristicTitle("Use sonnet 5.5 to code I will tell you what to do")).toBe("Code I Will Tell You What");
  });
  it("takes the first clause and keeps proper nouns", () => {
    expect(heuristicTitle("Hey, can you please fix the iOS login bug? It crashes")).toBe("Fix the iOS Login Bug");
    expect(heuristicTitle("I want to add dark mode to Squeak.\nMore detail")).toBe("Add Dark Mode to Squeak");
    expect(heuristicTitle("   ")).toBeNull();
  });
});

describe("titleModel / prompt", () => {
  it("is Haiku", () => expect(titleModel()).toBe("haiku"));
  it("clips the message and the reply", () => {
    const p = titlePrompt("a".repeat(3000), "b".repeat(900));
    expect(p.length).toBeLessThan(2200);
  });
});

const quick = { gapMs: 0, modelEnabled: () => true };

describe("AutoTitler", () => {
  it("stores the model's title and tells watchers", async () => {
    const store = makeStore();
    const id = chat(store, "We need to merge everything we have and clean up the repo");
    const onTitle = vi.fn();
    const call = vi.fn(async () => '"Merge branches and clean repo."');
    const t = new AutoTitler({ store, onTitle, call, ...quick });
    t.request(id);
    await t.idle();
    expect(store.getSession(id)).toMatchObject({ title: "Merge branches and clean repo", titleAuto: true });
    expect(onTitle).toHaveBeenCalledWith(id, "Merge branches and clean repo");
  });

  it("never overwrites a person's rename, even one made while the call ran", async () => {
    const store = makeStore();
    const named = chat(store, "hello there", "Mine");
    const racing = chat(store, "something else");
    const onTitle = vi.fn();
    const call = vi.fn(async () => {
      store.setTitle(racing, "Typed meanwhile");
      return "Auto Title";
    });
    const t = new AutoTitler({ store, onTitle, call, ...quick });
    t.request(named);
    t.request(racing);
    await t.idle();
    expect(store.getSession(named)!.title).toBe("Mine");
    expect(store.getSession(racing)).toMatchObject({ title: "Typed meanwhile", titleAuto: false });
    expect(onTitle).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic on failure, a bad answer, a timeout, or the switch off", async () => {
    const store = makeStore();
    const text = "Please fix the flaky upload test";
    const ids = [chat(store, text), chat(store, text), chat(store, text), chat(store, text)];
    const run = async (id: string, call: () => Promise<string>, extra = {}): Promise<void> => {
      const t = new AutoTitler({ store, onTitle: () => undefined, call, ...quick, ...extra });
      t.request(id);
      await t.idle();
    };
    await run(ids[0]!, async () => Promise.reject(new Error("not signed in")));
    await run(ids[1]!, async () => "one two three four five six seven eight nine ten");
    await run(ids[2]!, () => new Promise<string>(() => undefined), { timeoutMs: 20 });
    const off = vi.fn(async () => "Never Used");
    await run(ids[3]!, off, { modelEnabled: () => false });
    for (const id of ids) expect(store.getSession(id)!.title).toBe("Fix the Flaky Upload Test");
    expect(off).not.toHaveBeenCalled();
  });

  it("backfills at most 15 untitled chats with a message, once each", async () => {
    const store = makeStore();
    for (let i = 0; i < 20; i++) chat(store, `Task number ${i} please`);
    const empty = chat(store, null);
    const titled = chat(store, "already named", "Kept");
    const call = vi.fn(async () => {
      throw new Error("offline");
    });
    const t = new AutoTitler({ store, onTitle: () => undefined, call, ...quick });
    const first = t.backfill();
    await t.idle();
    expect(first).toHaveLength(15);
    expect(first).not.toContain(empty);
    expect(first).not.toContain(titled);
    expect(call).toHaveBeenCalledTimes(15);
    const second = t.backfill();
    await t.idle();
    expect(second).toHaveLength(5);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    expect(t.backfill()).toEqual([]);
  });
});
