import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeStore } from "../../native/store.js";
import { SqueakNativeObserver, claudeProjectFolder, summarizeRequest } from "./squeak-native.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-native-observer-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "native.db");
  const store = new NativeStore(dbPath);
  const observer = new SqueakNativeObserver({ dbPath, claudeProjectsDir: "/claude/projects" });
  return { dir, store, observer };
}

describe("SqueakNativeObserver", () => {
  it("sees no sessions when native.db does not exist", () => {
    const observer = new SqueakNativeObserver({ dbPath: "/nonexistent/native.db" });
    expect(observer.observe()).toEqual([]);
  });

  it("maps statuses to fleet states", () => {
    const { store, observer, dir } = setup();
    const make = (status: string, ended = false) => {
      const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
      store.db
        .prepare("UPDATE sessions SET status=?, last_turn_ended_at=? WHERE id=?")
        .run(status, ended ? "2026-11-08T10:00:00.000Z" : null, s.id);
      return s.id;
    };
    const ids = {
      working: make("working"),
      cancelling: make("cancelling"),
      permission: make("needs_user_permission"),
      plan: make("needs_plan_response"),
      input: make("needs_user_input"),
      stopping: make("stopping"),
      approval: make("awaiting_approval"),
      newPlan: make("awaiting_plan"),
      answer: make("awaiting_answer"),
      error: make("error"),
      finished: make("idle", true),
      idle: make("idle"),
    };
    const byId = new Map(observer.observe().map((s) => [s.sourceId, s.state]));
    expect(byId.get(ids.working)).toBe("working");
    expect(byId.get(ids.cancelling)).toBe("working");
    expect(byId.get(ids.permission)).toBe("awaiting_approval");
    expect(byId.get(ids.plan)).toBe("awaiting_input");
    expect(byId.get(ids.input)).toBe("awaiting_input");
    expect(byId.get(ids.stopping)).toBe("working");
    expect(byId.get(ids.approval)).toBe("awaiting_approval");
    expect(byId.get(ids.newPlan)).toBe("awaiting_input");
    expect(byId.get(ids.answer)).toBe("awaiting_input");
    expect(byId.get(ids.error)).toBe("error");
    expect(byId.get(ids.finished)).toBe("finished");
    expect(byId.get(ids.idle)).toBe("idle");
  });

  it("carries identity, a first-message title, the open request and the Claude transcript path", () => {
    const { store, observer, dir } = setup();
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    store.setAgentSessionId(s.id, "agent-123");
    store.appendMessage(s.id, "user", "user/text", { text: `${"word ".repeat(30)}` });
    store.createRequest(s.id, "tool", { toolName: "Bash", input: { command: "rm -rf build" } });
    store.db.prepare("UPDATE sessions SET status='needs_user_permission' WHERE id=?").run(s.id);

    const [observed] = observer.observe();
    expect(observed).toMatchObject({
      key: `squeak-native:${s.id}`,
      source: "squeak-native",
      origin: "squeak",
      agent: "claude",
      agentSessionId: "agent-123",
      cwd: dir,
      repoName: path.basename(dir),
      state: "awaiting_approval",
      detail: "Bash: rm -rf build",
      nativeRequest: { kind: "tool", summary: "Bash: rm -rf build" },
    });
    expect(observed!.title!.length).toBeLessThanOrEqual(60);
    expect(observed!.transcriptPath).toBe(path.join("/claude/projects", claudeProjectFolder(dir), "agent-123.jsonl"));
  });

  it("takes repo and branch from the workspace, and keeps archived ones retired", () => {
    const { store, observer, dir } = setup();
    const project = store.createProject({ name: "squeak", rootPath: dir, defaultBranch: "main" });
    const ws = store.createWorkspace({
      projectId: project.id,
      name: "oslo",
      path: path.join(dir, "oslo"),
      branch: "oslo",
    });
    store.createSession({ cwd: ws.path, agent: "codex", model: "m", permissionMode: "untrusted", workspaceId: ws.id });
    expect(observer.observe()[0]).toMatchObject({
      repoName: "squeak",
      branch: "oslo",
      transcriptPath: null,
      retired: false,
    });
    store.setWorkspaceState(ws.id, "archived");
    expect(observer.observe()[0]!.retired).toBe(true);
  });

  it("retires an archived chat so its transcript is not rediscovered", () => {
    const { store, observer, dir } = setup();
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    expect(observer.observe()[0]!.retired).toBe(false);
    store.setArchivedAt(s.id, "2026-11-13T10:00:00.000Z");
    expect(observer.observe()[0]!.retired).toBe(true);
  });

  it("never writes: the database opens read-only", () => {
    const { store, observer, dir } = setup();
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    const before = fs.statSync(path.join(dir, "native.db")).mtimeMs;
    observer.observe();
    expect(fs.statSync(path.join(dir, "native.db")).mtimeMs).toBe(before);
  });
});

describe("claudeProjectFolder", () => {
  it("turns every non-alphanumeric character into a dash, as Claude names its folders", () => {
    expect(claudeProjectFolder("/Users/x/.hyperframes-studio/Github")).toBe("-Users-x--hyperframes-studio-Github");
  });
});

describe("summarizeRequest", () => {
  it("clips a plan to 300 characters and names a tool's path", () => {
    expect(summarizeRequest("plan", { input: { plan: "p".repeat(500) } }).length).toBe(300);
    expect(summarizeRequest("tool", { toolName: "Edit", input: { file_path: "/a/b.ts" } })).toBe("Edit: /a/b.ts");
  });
});
