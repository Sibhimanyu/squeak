import { describe, expect, it } from "vitest";

import { NativeStore, searchableText, snippetAround } from "./store.js";

function setup() {
  const store = new NativeStore(":memory:");
  const pa = store.createProject({ name: "a", rootPath: "/a", defaultBranch: "main" });
  const pb = store.createProject({ name: "b", rootPath: "/b", defaultBranch: "main" });
  const wa = store.createWorkspace({ projectId: pa.id, name: "w", path: "/a/w", branch: "w" } as never);
  const wb = store.createWorkspace({ projectId: pb.id, name: "w", path: "/b/w", branch: "w" } as never);
  const sa = store.createSession({
    workspaceId: wa.id,
    cwd: "/a/w",
    agent: "claude",
    model: "m",
    permissionMode: "default",
    title: "Fix login",
  });
  const sb = store.createSession({
    workspaceId: wb.id,
    cwd: "/b/w",
    agent: "claude",
    model: "m",
    permissionMode: "default",
  });
  return { store, pa, pb, sa, sb };
}

describe("native search", () => {
  it("indexes user and assistant text as it arrives, and nothing else", () => {
    const { store, pa, sa } = setup();
    expect(store.search("pineapple", pa.id)).toEqual([]);
    store.appendMessage(sa.id, "user", "user/text", { text: "Please add a pineapple banner" });
    store.appendMessage(sa.id, "agent", "assistant", {
      message: {
        content: [
          { type: "text", text: "Done with the kumquat" },
          { type: "tool_use", name: "Bash", input: { command: "durian" } },
        ],
      },
    });
    expect(store.search("pineapple", pa.id)[0]).toMatchObject({ sessionId: sa.id, in: "message" });
    expect(store.search("kumquat", pa.id)).toHaveLength(1);
    expect(store.search("durian", pa.id)).toEqual([]);
    expect(store.search("pine", pa.id)).toHaveLength(1);
  });

  it("scopes to the project and matches titles", () => {
    const { store, pa, pb, sa, sb } = setup();
    store.appendMessage(sb.id, "user", "user/text", { text: "pineapple in b" });
    expect(store.search("pineapple", pa.id)).toEqual([]);
    expect(store.search("pineapple", pb.id)).toHaveLength(1);
    expect(store.search("pineapple", null)).toHaveLength(1);
    expect(store.search("login", pa.id)[0]).toMatchObject({ sessionId: sa.id, in: "title" });
  });

  it("drops pruned messages from the index", () => {
    const { store, pa, sa } = setup();
    const m = store.appendMessage(sa.id, "user", "user/text", { text: "mango" });
    store.pruneMessages(sa.id, m.seq);
    expect(store.search("mango", pa.id)).toEqual([]);
  });

  it("backfills an existing database once", () => {
    const { store, pa, sa } = setup();
    store.appendMessage(sa.id, "user", "user/text", { text: "papaya" });
    store.db.exec("DELETE FROM search_fts");
    (store as unknown as { setupSearch(): void }).setupSearch();
    expect(store.search("papaya", pa.id)).toHaveLength(1);
  });

  it("cuts a snippet around the match with its range", () => {
    const text = "x".repeat(100) + " needle " + "y".repeat(200);
    const s = snippetAround(text, ["needle"]);
    expect(s.snippet.slice(s.start, s.start + s.length)).toBe("needle");
    expect(s.snippet.length).toBeLessThan(160);
    expect(searchableText("item/agentMessage", { text: "hi" })).toBe("hi");
  });
});
