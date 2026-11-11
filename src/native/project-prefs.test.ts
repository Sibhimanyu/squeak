import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { PrefsError, ProjectPrefs, readLabels } from "./project-prefs.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40, 1)]);
const encode = async (b: Buffer): Promise<Buffer | null> => (b.length > 8 ? PNG : null);

describe("labels", () => {
  it("trims, dedupes ignoring case, and enforces limits", () => {
    expect(readLabels([" Work ", "work", "Home"])).toEqual(["Work", "Home"]);
    expect(() => readLabels([""])).toThrow(PrefsError);
    expect(() => readLabels(["x".repeat(25)])).toThrow(PrefsError);
    expect(() => readLabels(Array.from({ length: 9 }, (_, i) => `l${i}`))).toThrow(PrefsError);
    expect(() => readLabels("a")).toThrow(PrefsError);
  });
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-"));
  dirs.push(d);
  return d;
};

describe("ProjectPrefs", () => {
  it("keeps hidden and labels, counts labels, drops empty entries", () => {
    const p = new ProjectPrefs(tmp(), encode);
    p.patch("a", { labels: ["Work", "Mac"] });
    p.patch("b", { labels: ["work"], hidden: true });
    expect(p.get("b")).toEqual({ hidden: true, labels: ["work"] });
    expect(p.labels()).toEqual([
      { label: "Mac", count: 1 },
      { label: "Work", count: 2 },
    ]);
    p.patch("b", { hidden: false, labels: [] });
    expect(p.labels()).toHaveLength(2);
    expect(() => p.patch("a", { bogus: 1 })).toThrow(PrefsError);
    expect(() => p.patch("a", {})).toThrow(PrefsError);
    expect(() => p.patch("a", { hidden: "yes" })).toThrow(PrefsError);
  });

  it("stores, replaces and clears an icon after checking it", async () => {
    const p = new ProjectPrefs(tmp(), encode);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
    await p.setIcon("a", `data:image/jpeg;base64,${jpeg.toString("base64")}`);
    expect(p.iconPng("a")).toEqual(PNG);
    expect(p.iconUpdatedAt("a")).toBeTypeOf("number");
    await expect(p.setIcon("a", Buffer.from("not an image at all"))).rejects.toThrow(PrefsError);
    await expect(p.setIcon("a", Buffer.alloc(600 * 1024, 1))).rejects.toMatchObject({ status: 413 });
    await expect(p.setIcon("a", "data:text/plain;base64,AAAA")).rejects.toThrow(PrefsError);
    p.clearIcon("a");
    expect(p.iconPng("a")).toBeNull();
  });
});

describe("routes", () => {
  it("lists, patches, serves the icon and counts labels", async () => {
    const dir = tmp();
    const store = new NativeStore(":memory:");
    const host = new SessionHost({
      store,
      runnerFactory: () => ({ canSteer: false, send: async () => {}, close: async () => {} }) as never,
    });
    const workspaces = new WorkspaceManager({ store, root: path.join(dir, "ws") } as never);
    const tokenPath = path.join(dir, "token");
    const server = new NativeServer({
      host,
      store,
      workspaces,
      tokenPath,
      port: 0,
      routines: false,
      supportDir: dir,
      iconEncoder: encode,
    });
    const port = await server.start();
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const call = (
      method: string,
      url: string,
      body?: unknown,
      type = "application/json",
    ): Promise<{ status: number; body: Buffer }> =>
      new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        const r = http.request(
          { host: "127.0.0.1", port, path: url, method, headers: { "x-squeak-token": token, "content-type": type } },
          (res) => {
            const c: Buffer[] = [];
            res.on("data", (d: Buffer) => c.push(d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c) }));
          },
        );
        r.on("error", reject);
        r.end(data);
      });
    try {
      const project = store.createProject({ name: "p", rootPath: "/tmp/p", defaultBranch: "main" });
      const base = `/native/projects/${project.id}`;
      expect((await call("PATCH", `${base}/prefs`, { hidden: true, labels: ["Work"] })).status).toBe(200);
      expect((await call("PATCH", `${base}/prefs`, { nope: 1 })).status).toBe(400);
      expect((await call("GET", `${base}/icon`)).status).toBe(404);
      expect((await call("PUT", `${base}/icon`, PNG, "image/png")).status).toBe(200);
      const list = JSON.parse((await call("GET", "/native/projects")).body.toString()) as {
        projects: Record<string, unknown>[];
      };
      expect(list.projects[0]).toMatchObject({ hidden: true, labels: ["Work"], iconUrl: base + "/icon" });
      expect((await call("GET", `${base}/icon`)).body).toEqual(PNG);
      expect(JSON.parse((await call("GET", "/native/labels")).body.toString())).toEqual({
        labels: [{ label: "Work", count: 1 }],
      });
      expect((await call("DELETE", `${base}/icon`)).status).toBe(200);
      expect((await call("GET", `${base}/icon`)).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
