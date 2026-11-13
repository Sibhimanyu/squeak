import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { FlotillaService } from "./service.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
const docs = new Map<string, ChannelDoc>();
let failRipples = false;
const shared: CloudStore = {
  get: async (p) => docs.get(p) ?? null,
  set: async (p, doc) => {
    if (failRipples && p.includes("/ripples/")) throw new Error("timeout");
    docs.set(p, doc);
  },
  list: async (c) =>
    [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
  delete: async (p) => void docs.delete(p),
  watch: () => () => undefined,
};
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const mk = (name: string, owner: boolean) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approve-failure-"));
  dirs.push(dir);
  return new FlotillaService({
    store: shared,
    supportDir: dir,
    displayName: name,
    nest: `${name}-mac`,
    ...(owner ? { location: LOCATION } : {}),
    storeFor: () => shared,
  });
};

describe("approving a join", () => {
  it("succeeds when only the closing Ripple cannot be written (the member is in, the invite used)", async () => {
    const A = mk("Owner", true);
    const pond = await A.createPond({ name: "Site" });
    const { code } = await A.invite(pond.id, "viewer");
    await mk("Bea", false).join(code, "Bea");
    const [request] = (await A.view(pond.id)).joins;
    failRipples = true;
    try {
      await A.decideJoin(pond.id, request!.requestId, { approve: true });
    } finally {
      failRipples = false;
    }
    const view = await A.view(pond.id);
    expect(view.members.map((m) => m.name).sort()).toEqual(["Bea", "Owner"]);
    expect(view.joins).toHaveLength(0);
    expect(view.invites?.[0]?.state).toBe("accepted");
  });
});

describe("approving, removing and naming", () => {
  const joined = async () => {
    const A = mk("owner-login", true);
    const pond = await A.createPond({ name: "Site" });
    const { code } = await A.invite(pond.id, "viewer");
    await mk("Bea", false).join(code, "Bea");
    const [request] = (await A.view(pond.id)).joins;
    return { A, pondId: pond.id, request: request! };
  };

  it("two presses on one request write one member and one 'joined' Ripple", async () => {
    const { A, pondId, request } = await joined();
    await Promise.all([
      A.decideJoin(pondId, request.requestId, { approve: true }),
      A.decideJoin(pondId, request.requestId, { approve: true }),
    ]);
    // A press after it finished finds nothing waiting, quietly a 404.
    await expect(A.decideJoin(pondId, request.requestId, { approve: true })).rejects.toMatchObject({ status: 404 });
    const view = await A.view(pondId);
    expect(view.ripples.filter((r) => r.text === "joined" && r.actorName === "Bea")).toHaveLength(1);
  });

  it("removing a member writes 'was removed' even when the key rotation then fails", async () => {
    const { A, pondId, request } = await joined();
    await A.decideJoin(pondId, request.requestId, { approve: true });
    const bea = (await A.view(pondId)).members.find((m) => m.name === "Bea")!;
    const realSet = shared.set;
    shared.set = async (p, doc) => {
      if (p.includes("/keys/") || p.endsWith("/pond/meta")) throw new Error("timeout");
      return realSet(p, doc);
    };
    try {
      await A.removeMember(pondId, bea.id).catch(() => undefined);
    } finally {
      shared.set = realSet;
    }
    expect((await A.view(pondId)).ripples.map((r) => r.text)).toContain("removed Bea");
  });

  it("ripples carry the actor's name, never only a member id", async () => {
    const { A, pondId } = await joined();
    const ripples = (await A.view(pondId)).ripples;
    expect(ripples.length).toBeGreaterThan(0);
    for (const r of ripples) expect(r.actorName).toBe("owner-login");
  });

  it("a real name replaces the old login-name default, in the saved identity and the owner's member document", async () => {
    const { A, pondId } = await joined();
    expect(
      await A.updateOwnProfile(
        { name: "Sibhi M", nest: "Studio Mac" },
        { name: "owner-login", nest: "owner-login-mac" },
      ),
    ).toBe(true);
    expect(A.me.name).toBe("Sibhi M");
    const me = (await A.view(pondId)).members.find((m) => m.you)!;
    expect(me).toMatchObject({ name: "Sibhi M", nest: "Studio Mac" });
    // Run again, or after a name the person chose: nothing changes.
    expect(
      await A.updateOwnProfile({ name: "Other", nest: "X" }, { name: "owner-login", nest: "owner-login-mac" }),
    ).toBe(false);
  });
});

describe("approving without waiting, and finishing a removal", () => {
  const joined = async () => {
    const A = mk("owner-login", true);
    const pond = await A.createPond({ name: "Site" });
    const { code } = await A.invite(pond.id, "viewer");
    await mk("Bea", false).join(code, "Bea");
    const [request] = (await A.view(pond.id)).joins;
    return { A, pondId: pond.id, request: request! };
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  };

  it("answers at once, shows 'working' while a slow relay runs, then the member and no request", async () => {
    const { A, pondId, request } = await joined();
    const realSet = shared.set;
    shared.set = async (p, doc) => {
      if (p.includes("/members/")) await new Promise((r) => setTimeout(r, 80));
      return realSet(p, doc);
    };
    try {
      const t = Date.now();
      A.startJoinDecision(pondId, request.requestId, { approve: true });
      expect(Date.now() - t).toBeLessThan(50);
      const during = (await A.view(pondId)).joins;
      expect(during[0]?.decision).toEqual({ state: "working", line: "Approving...", approve: true });
      await until(async () => (await A.view(pondId)).joins.length === 0);
    } finally {
      shared.set = realSet;
    }
    const view = await A.view(pondId);
    expect(view.members.map((m) => m.name).sort()).toEqual(["Bea", "owner-login"]);
    expect(view.joins).toHaveLength(0);
  });

  it("a failed decision stays on the card with a sentence", async () => {
    const { A, pondId, request } = await joined();
    const realSet = shared.set;
    shared.set = async (p, doc) => {
      if (p.includes("/keys/")) throw new Error("timeout");
      return realSet(p, doc);
    };
    try {
      A.startJoinDecision(pondId, request.requestId, { approve: true });
      await until(async () => (await A.view(pondId)).joins[0]?.decision?.state === "failed");
    } finally {
      shared.set = realSet;
    }
    const [join] = (await A.view(pondId)).joins;
    expect(join?.decision?.error).toMatch(/\S/);
    expect((await A.view(pondId)).members.map((m) => m.name)).not.toContain("Bea");
  });

  it("the member document appears only after their key is written", async () => {
    const { A, pondId, request } = await joined();
    const order: string[] = [];
    const realSet = shared.set;
    shared.set = async (p, doc) => {
      if (p.includes("/keys/")) order.push("key");
      if (p.includes("/members/") && !order.includes("member")) order.push("member");
      return realSet(p, doc);
    };
    try {
      await A.decideJoin(pondId, request.requestId, { approve: true });
    } finally {
      shared.set = realSet;
    }
    expect(order.indexOf("key")).toBeLessThan(order.indexOf("member"));
  });

  it("a removal whose rotation failed is finished by a retry, not answered 404, and by the next view", async () => {
    const { A, pondId, request } = await joined();
    await A.decideJoin(pondId, request.requestId, { approve: true });
    const bea = (await A.view(pondId)).members.find((m) => m.name === "Bea")!;
    const realSet = shared.set;
    shared.set = async (p, doc) => {
      if (p.endsWith("/pond/meta")) throw new Error("timeout");
      return realSet(p, doc);
    };
    await A.removeMember(pondId, bea.id).catch(() => undefined);
    shared.set = realSet;
    // The retry finishes the rotation instead of "No such member."
    await expect(A.removeMember(pondId, bea.id)).resolves.toBeUndefined();
    await expect(A.removeMember(pondId, bea.id)).rejects.toMatchObject({ status: 404 });
  });

  it("the next view finishes a pending rotation", async () => {
    const { A, pondId, request } = await joined();
    await A.decideJoin(pondId, request.requestId, { approve: true });
    const bea = (await A.view(pondId)).members.find((m) => m.name === "Bea")!;
    const realSet = shared.set;
    shared.set = async (p, doc) => {
      if (p.endsWith("/pond/meta")) throw new Error("timeout");
      return realSet(p, doc);
    };
    await A.removeMember(pondId, bea.id).catch(() => undefined);
    shared.set = realSet;
    await A.view(pondId); // finishes it
    await expect(A.removeMember(pondId, bea.id)).rejects.toMatchObject({ status: 404 });
  });
});
