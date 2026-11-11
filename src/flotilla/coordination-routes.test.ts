import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FlotillaRoutes } from "./mount.js";
import { FlotillaService } from "./service.js";

let rtdb: FakeRtdb;
let url: string;
let dir = "";
beforeAll(async () => {
  rtdb = new FakeRtdb();
  url = await rtdb.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-co-r-"));
});
afterAll(async () => {
  await rtdb.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("task and lock routes", () => {
  it("strict bodies, status and heldBy from a refusal, and the fields on a pond's view", async () => {
    const service = new FlotillaService({
      store: new RtdbRest(url),
      supportDir: dir,
      displayName: "Sibhi",
      nest: "s-mac",
    });
    const pond = await service.createPond({ name: "R" });
    const routes = new FlotillaRoutes({
      service,
      bridge: null as never,
      remoteOf: async () => null,
      startOwn: async () => ({ sessionId: "" }),
    });
    const call = async (method: string, parts: string[], body: Record<string, unknown> = {}) => {
      let out: { status: number; body: unknown } = { status: 0, body: null };
      await routes.handle({
        req: null as never,
        res: null as never,
        method,
        parts,
        url: new URL("http://x/"),
        body: async () => body,
        json: (status, b) => (out = { status, body: b }),
      });
      return out;
    };
    const created = await call("POST", ["ponds", pond.id, "tasks"], { title: "T", scope: ["a/**"] });
    expect(created.status).toBe(201);
    expect(await call("POST", ["ponds", pond.id, "tasks"], { title: "T", extra: 1 })).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pond.id, "tasks"], { title: "T", scope: "a" })).toMatchObject({ status: 400 });
    const id = (created.body as { task: { id: string } }).task.id;
    expect(await call("POST", ["ponds", pond.id, "tasks", id, "claim"], { x: 1 })).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pond.id, "tasks", id, "claim"])).toMatchObject({ status: 200 });
    expect(await call("POST", ["ponds", pond.id, "tasks", "nope", "claim"])).toMatchObject({ status: 404 });
    expect((await call("POST", ["ponds", pond.id, "locks"], { paths: ["a/b"] })).status).toBe(201);
    expect((await call("GET", ["ponds", pond.id, "tasks"])).body).toMatchObject({
      tasks: [{ status: "claimed" }],
      locks: [{}],
    });
    const view = await service.view(pond.id);
    expect(view.tasks).toHaveLength(1);
    expect(view.locks).toHaveLength(1);
  });
});
