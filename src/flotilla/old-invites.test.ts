import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ChannelDoc, CloudStore } from "../cloud/store.js";
import { named } from "./named-account.test-fixture.js";
import { FlotillaService } from "./service.js";

// The way in is email only (docs/ponds.md, "Invitations"): what the old invite and join paths left in `ponds.json` goes.
const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };

function memoryStore(): CloudStore {
  const docs = new Map<string, ChannelDoc>();
  return {
    get: async (p) => docs.get(p) ?? null,
    set: async (p, doc) => void docs.set(p, doc),
    list: async (c) =>
      [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
    delete: async (p) => void docs.delete(p),
    watch: () => () => undefined,
  };
}

const open = (dir: string) =>
  new FlotillaService({ store: memoryStore(), supportDir: dir, account: named("Me"), nest: "mac", location: LOCATION });

describe("old invite records are dropped", () => {
  it("a restart removes saved invites (their codes carried the pond key) and join words, and keeps the pond", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "old-invites-"));
    const first = open(dir);
    const pond = await first.createPond({ name: "Alpha", projectId: "p1" });
    const file = path.join(dir, "flotilla", "ponds.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.ponds[pond.id].invites = [{ id: "i1", secret: "s", role: "member", expiresAt: 1, code: "squeak-pond:abc" }];
    saved.ponds[pond.id].words = ["a", "b", "c"];
    saved.ponds[pond.id].requestedRole = "member";
    fs.writeFileSync(file, JSON.stringify(saved));

    const again = open(dir);
    again.start();
    again.stop();
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toContain("squeak-pond:");
    const ponds = JSON.parse(after).ponds;
    expect(ponds[pond.id]).toMatchObject({ id: pond.id, name: "Alpha", role: "owner" });
    expect(ponds[pond.id]).not.toHaveProperty("invites");
    expect(ponds[pond.id]).not.toHaveProperty("words");
    expect(ponds[pond.id]).not.toHaveProperty("requestedRole");
  });

  it("a pending record that is no device's (an old join request) is forgotten, not left waiting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "old-invites-"));
    const service = open(dir);
    const pond = await service.createPond({ name: "Alpha", projectId: "p1" });
    const stored = (service as unknown as { pondsFile: { data: { ponds: Record<string, Record<string, unknown>> } } })
      .pondsFile.data.ponds[pond.id]!;
    Object.assign(stored, { status: "pending", role: "viewer", requestId: "r1" });
    await service.refresh(pond.id);
    expect((await service.list()).map((p) => p.id)).toEqual([]);
  });
});
