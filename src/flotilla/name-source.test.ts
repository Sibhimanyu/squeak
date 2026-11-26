import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ChannelDoc, CloudStore } from "../cloud/store.js";
import { named, verifying } from "./named-account.test-fixture.js";
import { FlotillaService, SIGNED_OUT_MEMBER, type AccountPort } from "./service.js";

// A person's name has one source: their Squeak account (name, else email). Nothing on the Mac, in a pond or in a
// joiner's request can change how a person is shown.
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

function account(state: { name: string | null; email: string | null }): AccountPort {
  return {
    name: () => state.name,
    email: () => state.email,
    attest: async () => "t",
    names: async () => ({ names: {} }),
  };
}

function make(acct: AccountPort | null, displayName = "mac-login-name", dir?: string) {
  return new FlotillaService({
    store: memoryStore(),
    supportDir: dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "name-source-")),
    displayName,
    nest: "mac",
    location: LOCATION,
    ...(acct ? { account: acct } : {}),
  });
}

describe("a person's name is their account's", () => {
  it("shows the account name, never the Mac's own label", async () => {
    const s = make(account({ name: "Sibhi M", email: "sibhi@example.com" }), "Computer User");
    expect(s.me.name).toBe("Sibhi M");
    const pond = await s.createPond({ name: "P", projectId: "proj-P" });
    const me = (await s.view(pond.id)).members.find((m) => m.you)!;
    expect(me.name).toBe("Sibhi M");
    expect(me.email).toBe("sibhi@example.com");
  });

  it("shows the email when the account has no name, owner included", async () => {
    const s = make(account({ name: null, email: "sibhi@example.com" }));
    expect(s.me.name).toBe("sibhi@example.com");
    const pond = await s.createPond({ name: "P", projectId: "proj-P" });
    const v = await s.view(pond.id);
    expect(v.members.find((m) => m.you)!.name).toBe("sibhi@example.com");
    expect(v.me.name).toBe("sibhi@example.com");
  });

  it("a device-local name change never changes how the person is shown", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "name-source-"));
    const acct = account({ name: "Sibhi M", email: "sibhi@example.com" });
    expect(make(acct, "old-login", dir).me.name).toBe("Sibhi M");
    expect(make(acct, "New Login", dir).me.name).toBe("Sibhi M");
  });

  it("has no profile rename: only the computer name can be refreshed", async () => {
    const s = make(account({ name: "Sibhi M", email: "sibhi@example.com" }));
    await s.createPond({ name: "P", projectId: "proj-P" });
    expect(await s.updateOwnProfile({ nest: "Studio" }, { nest: "other" })).toBe(false);
    expect(s.me.name).toBe("Sibhi M");
  });

  it("a signed-out Mac does not borrow the login name", () => {
    const s = make(null, "mac-login-name");
    expect(s.me.name).not.toBe("mac-login-name");
  });

  describe("a joiner", () => {
    const pair = (verified: boolean) => {
      const store = memoryStore();
      const mk = (label: string, owner: boolean) =>
        new FlotillaService({
          store: verified ? verifying(store) : store,
          supportDir: fs.mkdtempSync(path.join(os.tmpdir(), "name-source-")),
          account: named(label, `${label.toLowerCase()}@example.test`),
          nest: `${label}-mac`,
          ...(owner ? { location: LOCATION } : {}),
          storeFor: () => (verified ? verifying(store) : store),
        });
      return { owner: mk("Owner", true), joiner: mk("Bea", false) };
    };

    it("is shown by the account the relay saw sign the request, with its email", async () => {
      const { owner, joiner } = pair(true);
      const pond = await owner.createPond({ name: "P", projectId: "proj-P" });
      await joiner.join((await owner.invite(pond.id, "member")).code);
      const [req] = (await owner.view(pond.id)).joins;
      expect(req).toMatchObject({ name: "Bea", verifiedEmail: "bea@example.test" });
      await owner.decideJoin(pond.id, req!.requestId, { approve: true });
      const bea = (await owner.view(pond.id)).members.find((m) => !m.you)!;
      expect(bea).toMatchObject({ name: "Bea", email: "bea@example.test" });
    });

    it("is never shown by the name their own app wrote when nothing verifies the sign-in", async () => {
      const { owner, joiner } = pair(false);
      const pond = await owner.createPond({ name: "P", projectId: "proj-P" });
      await joiner.join((await owner.invite(pond.id, "member")).code);
      const [req] = (await owner.view(pond.id)).joins;
      expect(req!.name).toBe(SIGNED_OUT_MEMBER);
      await owner.decideJoin(pond.id, req!.requestId, { approve: true });
      expect((await owner.view(pond.id)).members.find((m) => !m.you)!.name).toBe(SIGNED_OUT_MEMBER);
    });
  });
});
