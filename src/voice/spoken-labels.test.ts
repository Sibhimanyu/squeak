import { describe, expect, it } from "vitest";

import { cutAtWord, spokenChat, spokenChats, spokenWorkspace, speakable } from "./spoken-labels.js";

const s = (over: Record<string, unknown> = {}) => ({
  key: "k",
  agent: "claude" as const,
  cwd: "/Users/me/conductor/workspaces/squeak/ushuaia",
  repoName: "squeak",
  branch: "telegram-formatting-and-claude-fixes",
  title: null as string | null,
  ...over,
});

describe("spoken labels", () => {
  it("names a workspace by repository and folder, never the branch tail", () => {
    const label = spokenWorkspace(s());
    expect(label).toBe("squeak, ushuaia");
    expect(label).not.toContain("…");
  });

  it("falls back to repo, folder, then a branch cut at a word", () => {
    expect(spokenWorkspace(s({ cwd: null }))).toBe("squeak");
    expect(spokenWorkspace(s({ repoName: null }))).toBe("ushuaia");
    expect(spokenWorkspace(s({ cwd: null, repoName: null }))).toBe("telegram formatting and claude fixes");
    const long = spokenWorkspace(s({ cwd: null, repoName: null, branch: "word-".repeat(30) }));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).not.toContain("…");
  });

  it("does not repeat a repo that is also the folder", () => {
    expect(spokenWorkspace(s({ cwd: "/x/Squeak" }))).toBe("squeak");
  });

  it("speaks a chat's title cut at a word, with no ellipsis, emoji, markdown or links", () => {
    const label = spokenChat(
      s({ title: "🚀 **App quitting loop** see https://x.io/a and fix the_really_long auto-update behaviour please" }),
    );
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toMatch(/^App quitting loop see/);
    expect(label).not.toMatch(/[…*🚀/]/u);
    expect(label.endsWith("beh")).toBe(false);
  });

  it("uses the agent for an empty or Untitled chat", () => {
    expect(spokenChat(s({ title: null }))).toBe("claude chat");
    expect(spokenChat(s({ title: "Untitled", agent: "codex" }))).toBe("codex chat");
    expect(spokenChat(s({ title: "🚀" }))).toBe("claude chat");
  });

  it("numbers chats of one workspace that speak alike", () => {
    const list = [s({ key: "a" }), s({ key: "b" }), s({ key: "c" }), s({ key: "d", cwd: "/other" })];
    const out = spokenChats(list, (x) => x.cwd);
    expect([...out.values()]).toEqual(["claude chat", "claude chat two", "claude chat three", "claude chat"]);
  });

  it("helpers", () => {
    expect(speakable("a_b-c  /Users/me/x d …")).toBe("a b c d");
    expect(cutAtWord("one two three", 8)).toBe("one two");
    expect(cutAtWord("one two three", 7)).toBe("one two");
  });
});
