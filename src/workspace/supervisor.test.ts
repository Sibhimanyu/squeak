import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { asSessionId, asWorkspaceId, LOCAL_RUNTIME_ID } from "../core/types.js";
import { ProcessSupervisor, type StartProcessInput } from "./supervisor.js";
import { fakeSpawner, tmpDir } from "./test-utils.js";

const input = (id = "p1"): StartProcessInput => ({
  id,
  workspaceId: asWorkspaceId("w"),
  sessionId: asSessionId(id),
  runtimeId: LOCAL_RUNTIME_ID,
  provider: "claudeCode",
  spec: { executable: "claude", args: ["-p"], env: {}, cwd: "/tmp", requiresPTY: false },
});

describe("ProcessSupervisor", () => {
  it("tracks pid and state, captures logs, records exit", async () => {
    const { spawner, procs } = fakeSpawner();
    const logDir = tmpDir();
    const changes: string[] = [];
    const sup = new ProcessSupervisor({
      spawner,
      logDir,
      redact: (t) => t.replace("sekret", "[x]"),
      onChange: (r) => changes.push(r.state),
    });
    const rec = sup.start(input());
    expect(rec).toMatchObject({ state: "running", pid: 40_000 });
    procs[0]?.emitOutput("stdout", "hello sekret");
    procs[0]?.emitOutput("stderr", "oops");
    expect(fs.readFileSync(path.join(logDir, "p1.stdout.log"), "utf8")).toBe("hello [x]");
    expect(fs.readFileSync(path.join(logDir, "p1.stderr.log"), "utf8")).toBe("oops");
    sup.write("p1", "hi\n");
    expect(procs[0]?.written).toEqual(["hi\n"]);
    procs[0]?.exit(0);
    expect(sup.get("p1")).toMatchObject({ state: "exited", exitCode: 0 });
    expect(changes).toEqual(["running", "exited"]);
    expect(() => sup.write("p1", "x")).toThrow();
  });

  it("stops with SIGTERM and does not escalate when it obeys", async () => {
    const { spawner, procs } = fakeSpawner();
    const sup = new ProcessSupervisor({ spawner, logDir: tmpDir() });
    sup.start(input());
    const r = await sup.stop("p1", 50);
    expect(r?.state).toBe("exited");
    expect(procs[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL after the grace period", async () => {
    const { spawner, procs } = fakeSpawner({ ignoreTerm: true });
    const sup = new ProcessSupervisor({ spawner, logDir: tmpDir() });
    sup.start(input());
    const r = await sup.stop("p1", 30);
    expect(procs[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r).toMatchObject({ state: "exited", signal: "SIGKILL" });
  });

  it("restarts with the same spec and counts restarts", async () => {
    const { spawner, procs } = fakeSpawner();
    const sup = new ProcessSupervisor({ spawner, logDir: tmpDir() });
    sup.start(input());
    const r = await sup.restart("p1", 30);
    expect(procs).toHaveLength(2);
    expect(r).toMatchObject({ state: "running", restarts: 1, pid: 40_001 });
    expect(() => sup.start(input())).toThrow(/already running/);
    await sup.restart("p1", 30);
    expect(sup.get("p1")?.restarts).toBe(2);
  });

  it("a failed spawn is an error, not a tracked process", () => {
    const { spawner } = fakeSpawner({ failSpawn: true });
    const sup = new ProcessSupervisor({ spawner, logDir: tmpDir() });
    expect(() => sup.start(input())).toThrow(/Could not start/);
    expect(sup.get("p1")).toBeUndefined();
  });
});
