import { describe, expect, it } from "vitest";

import { cutAtWord, spokenChat, numberRepeats, spokenChats, spokenWorkspace, speakable } from "./spoken-labels.js";

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
  it("names a workspace by repository and branch, never the folder", () => {
    const label = spokenWorkspace(s());
    expect(label).toBe("squeak, telegram formatting and claude fixes");
    expect(label).not.toContain("ushuaia");
    expect(label).not.toContain("…");
  });

  it("drops everything up to the last slash of the branch", () => {
    expect(spokenWorkspace(s({ branch: "sibhimanyu/fix-parser" }))).toBe("squeak, fix parser");
  });

  it("speaks just the repo when the branch says nothing", () => {
    for (const branch of [null, "HEAD", "main", "master", "ushuaia", "me/Ushuaia"]) {
      expect(spokenWorkspace(s({ branch }))).toBe("squeak");
    }
    expect(spokenWorkspace(s({ branch: "develop", baseRef: "origin/develop" }))).toBe("squeak");
    expect(spokenWorkspace(s({ branch: "develop", baseRef: "origin/main" }))).toBe("squeak, develop");
  });

  it("falls back to the branch alone, then a workspace", () => {
    expect(spokenWorkspace(s({ repoName: null }))).toBe("telegram formatting and claude fixes");
    expect(spokenWorkspace(s({ repoName: null, branch: "main" }))).toBe("a workspace");
    expect(spokenWorkspace(s({ cwd: null, repoName: null, branch: null }))).toBe("a workspace");
    const long = spokenWorkspace(s({ cwd: null, repoName: null, branch: "word-".repeat(30) }));
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).not.toContain("…");
  });

  it("numbers workspaces that speak alike", () => {
    expect(numberRepeats(["squeak", "blume", "Squeak", "squeak"])).toEqual([
      "squeak",
      "blume",
      "Squeak two",
      "squeak three",
    ]);
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
