// PondEnding (issues #142, #143): tested at its interface, first with a fake port (the sequence, the progress record, the
// words, the sharing state), then through the service for what only the real steps show (a local Delete keeps its id and
// Ducks, a shared Delete resumes after the relay failed, Remove from Squeak ends a shared Pond, an invite shares first).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { ChannelDoc, CloudStore } from "../cloud/store.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { InviteRefused, type PondInvites } from "./invites-port.js";
import { named } from "./named-account.test-fixture.js";
import {
  PondEnding,
  offerFor,
  type EndStep,
  type EndingFacts,
  type EndingPort,
  type EndingRecord,
} from "./pond-ending.js";
import { RelayRefused } from "./relay.js";
import { FlotillaService } from "./service.js";
import { FlotillaError } from "./types.js";

const base: EndingFacts = {
  id: "p1",
  name: "Alpha",
  role: "owner",
  local: false,
  status: "active",
  people: 3,
  cloud: true,
};

/** A port over one in-memory Pond: records what ran, and fails the steps a test names. */
function fakePort(initial: Partial<EndingFacts> = {}) {
  let facts: EndingFacts | null = { ...base, ...initial };
  const ran: string[] = [];
  const failing = new Map<string, number>();
  let unindexed: string[] = [];
  const port: EndingPort = {
    facts: () => (facts ? { ...facts } : null),
    mark: (_id, ending) => {
      if (!facts) return;
      if (ending) facts.ending = ending;
      else delete facts.ending;
    },
    run: async (_id, step) => {
      const left = failing.get(step) ?? 0;
      if (left > 0) {
        failing.set(step, left - 1);
        throw new FlotillaError(`The ${step} step failed.`, 503);
      }
      ran.push(step);
      if (step === "forget" || step === "remove") facts = null;
    },
    changed: () => undefined,
    removeMember: async (_id, memberId) => {
      ran.push(`member ${memberId}`);
      if (ran.filter((r) => r === `member ${memberId}`).length > 1) throw new FlotillaError("No such member.", 404);
      unindexed = ["acct"];
    },
    unindexed: () => unindexed,
    settleIndex: async () => {
      const left = failing.get("index") ?? 0;
      if (left > 0) {
        failing.set("index", left - 1);
        throw new Error("relay down");
      }
      ran.push("index");
      unindexed = [];
    },
    publish: async () => {
      if ((failing.get("publish") ?? 0) > 0) {
        failing.set("publish", 0);
        throw new FlotillaError("publish failed", 503);
      }
      ran.push("publish");
      if (facts) facts.local = false;
    },
    ensureAtRelay: async () => {
      if ((failing.get("relay") ?? 0) > 0) {
        failing.set("relay", 0);
        throw new FlotillaError("relay failed", 503);
      }
      ran.push("relay");
    },
    markSharing: (_id, started) => {
      if (!facts) return;
      if (started) facts.sharingStarted = true;
      else delete facts.sharingStarted;
    },
    unfinished: () => (facts && (facts.ending || unindexed.length) ? [facts.id] : []),
  };
  return {
    port,
    ran,
    fail: (step: string, times = 1) => failing.set(step, times),
    facts: () => facts,
    ending: (): EndingRecord | undefined => facts?.ending,
  };
}

describe("PondEnding.offer: the one place that decides local versus shared", () => {
  it("a local Pond is removed from Squeak; a shared one is deleted for everyone; a Member leaves", () => {
    const local = offerFor({ ...base, local: true, people: 1 })!;
    expect(local.primary).toBe("delete");
    expect(local.words.menu).toBe("Remove from Squeak…");
    expect(local.words.title).toBe("Remove Alpha from Squeak?");
    expect(local.words.button).toBe("Remove from Squeak");
    expect(local.words.message).toBe(
      "Squeak forgets this folder and its Pond. The folder and its files stay on your Mac.",
    );

    const shared = offerFor(base)!;
    expect(shared.primary).toBe("delete");
    expect(shared.words.title).toBe("Delete Alpha for everyone?");
    expect(shared.words.message).toMatch(/2 other people will lose access/);
    expect(shared.words.button).toBe("Delete for everyone");

    const member = offerFor({ ...base, role: "member", ownerName: "Sibhi" })!;
    expect(member.primary).toBe("leave");
    expect(member.words.menu).toBe("Leave Pond…");
    expect(member.words.message).toMatch(/new invite from Sibhi/);

    expect(offerFor({ ...base, status: "over" })!.primary).toBe("forget");
  });

  it("says why it cannot be done when there is no cloud to reach (never on a local Pond)", () => {
    expect(offerFor({ ...base, cloud: false })!.blockedBy).toMatch(/can't reach its cloud/);
    expect(offerFor({ ...base, role: "viewer", cloud: false })!.blockedBy).toMatch(/can't reach its cloud/);
    expect(offerFor({ ...base, local: true, cloud: false })!.blockedBy).toBeUndefined();
  });
});

describe("PondEnding.end: cloud first, progress recorded, nothing swallowed", () => {
  it("runs a shared delete in order and a local one as a single step", async () => {
    const shared = fakePort();
    await new PondEnding(shared.port).end("p1", "delete");
    expect(shared.ran).toEqual(["tell", "revoke", "cloud", "documents", "forget"]);

    const local = fakePort({ local: true });
    await new PondEnding(local.port).end("p1", "delete");
    expect(local.ran).toEqual(["remove"]);
  });

  it("a failed step stays in the record with its sentence, and the next press resumes at that step", async () => {
    const f = fakePort();
    const ending = new PondEnding(f.port);
    f.fail("cloud");
    await expect(ending.end("p1", "delete")).rejects.toThrow("The cloud step failed.");
    expect(f.ran).toEqual(["tell", "revoke"]);
    expect(f.ending()).toEqual({ kind: "delete", step: "cloud", failed: "The cloud step failed." });
    expect(ending.view("p1").ending).toEqual({
      kind: "delete",
      line: "Couldn't finish deleting Alpha.",
      failed: "The cloud step failed.",
    });

    await ending.end("p1", "delete");
    // Resumed: tell and revoke did not run again.
    expect(f.ran).toEqual(["tell", "revoke", "cloud", "documents", "forget"]);
    expect(f.facts()).toBeNull();
  });

  it("a half-done end resumes at start, and an unfinished one is never turned into another kind", async () => {
    const f = fakePort({ ending: { kind: "delete", step: "documents", failed: "x" } });
    const ending = new PondEnding(f.port);
    await expect(ending.end("p1", "leave")).rejects.toThrow(/owner can't leave|can't leave/);
    await ending.resume();
    expect(f.ran).toEqual(["documents", "forget"]);

    const g = fakePort({ role: "member", ending: { kind: "leave", step: "owner" } });
    await expect(new PondEnding(g.port).end("p1", "delete")).rejects.toThrow(/Only an owner/);
  });

  it("a Member's leave runs the cloud, tells the Owner, then forgets; an Owner is refused with a sentence", async () => {
    const m = fakePort({ role: "member" });
    m.fail("owner");
    const ending = new PondEnding(m.port);
    await expect(ending.end("p1", "leave")).rejects.toThrow("The owner step failed.");
    expect(m.ending()).toMatchObject({ kind: "leave", step: "owner", failed: "The owner step failed." });
    await ending.end("p1", "leave");
    expect(m.ran).toEqual(["cloud", "owner", "forget"]);

    await expect(new PondEnding(fakePort().port).end("p1", "leave")).rejects.toMatchObject({
      status: 409,
      message: "An owner can't leave a pond: delete it instead.",
    });
    await expect(new PondEnding(fakePort({ role: "member" }).port).end("p1", "forget")).rejects.toThrow(
      /Leave it first/,
    );
    await expect(new PondEnding(fakePort({ role: "member", status: "over" }).port).end("p1", "leave")).resolves.toBe(
      undefined,
    );
  });

  it("a second press while one runs joins it", async () => {
    const f = fakePort();
    const ending = new PondEnding(f.port);
    await Promise.all([ending.end("p1", "delete"), ending.end("p1", "delete")]);
    expect(f.ran.filter((r) => r === "cloud")).toHaveLength(1);
  });
});

describe("PondEnding.removeMember: the account index is settled, never swallowed", () => {
  it("a failed index call says so and the retry settles it instead of answering 'No such member'", async () => {
    const f = fakePort();
    const ending = new PondEnding(f.port);
    f.fail("index");
    await expect(ending.removeMember("p1", "m1")).rejects.toThrow(/Couldn't finish removing them from Alpha/);
    expect(f.port.unindexed("p1")).toEqual(["acct"]);
    await ending.removeMember("p1", "m1");
    expect(f.port.unindexed("p1")).toEqual([]);
    expect(f.ran).toContain("index");
  });

  it("at start an index left wrong is settled", async () => {
    const f = fakePort();
    const ending = new PondEnding(f.port);
    f.fail("index");
    await expect(ending.removeMember("p1", "m1")).rejects.toThrow();
    await ending.resume();
    expect(f.port.unindexed("p1")).toEqual([]);
  });
});

describe("PondEnding.share: idempotent and resumable", () => {
  it("is local, then sharing while unfinished, then shared; a failure at the relay resumes there", async () => {
    const f = fakePort({ local: true, people: 1 });
    const ending = new PondEnding(f.port);
    expect(ending.sharing("p1")).toBe("local");
    f.fail("relay");
    await expect(ending.share("p1")).rejects.toThrow("relay failed");
    expect(ending.sharing("p1")).toBe("sharing");
    await ending.share("p1");
    expect(ending.sharing("p1")).toBe("shared");
    await ending.share("p1");
    expect(ending.sharing("p1")).toBe("shared");
  });

  it("only the Owner shares", async () => {
    await expect(new PondEnding(fakePort({ role: "member" }).port).share("p1")).rejects.toThrow(/Only an owner/);
  });
});

// ---- through the service ----

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

class Cloud {
  docs = new Map<string, ChannelDoc>();
  failWrites = false;
  failDeletes = false;
  store(): CloudStore {
    return {
      get: async (p) => this.docs.get(p) ?? null,
      set: async (p, doc) => {
        if (this.failWrites) throw new Error("offline");
        this.docs.set(p, doc);
      },
      list: async (c) =>
        [...this.docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
      delete: async (p) => {
        if (this.failDeletes) throw new Error("offline");
        this.docs.delete(p);
      },
      watch: () => () => undefined,
    };
  }
  mac(
    name: string,
    options: {
      owner?: boolean;
      dir?: string;
      relay?: unknown;
      invites?: PondInvites;
      removeProject?: (projectId: string) => Promise<void>;
    } = {},
  ) {
    const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pond-ending-"));
    if (!options.dir) dirs.push(dir);
    const store = this.store();
    const service = new FlotillaService({
      store,
      supportDir: dir,
      account: named(name),
      nest: `${name}'s Mac`,
      deleteGraceMs: 0,
      ...(options.owner ? { location: LOCATION } : {}),
      storeFor: () => store,
      ...(options.relay ? { relay: options.relay as never } : {}),
      ...(options.invites ? { invites: options.invites } : {}),
      ...(options.removeProject ? { removeProject: options.removeProject } : {}),
    });
    return { dir, service };
  }
  forPond(id: string): string[] {
    return [...this.docs.keys()].filter((k) => k.startsWith(`channels/${id}/`));
  }
}

describe("Delete on a local Pond is Remove from Squeak (the service)", () => {
  it("runs the host's removal, so the project and its Pond leave together and no dead-end row is left", async () => {
    const c = new Cloud();
    const removed: string[] = [];
    const A = c.mac("Sibhi", {
      owner: true,
      removeProject: async (id) => {
        removed.push(id);
        A.service.projectRemoved(id); // what the host does after removing the project
      },
    });
    const made = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    const offer = A.service.endOffer(made.id)!;
    expect(offer.words).toMatchObject({
      menu: "Remove from Squeak…",
      message: "Squeak forgets this folder and its Pond. The folder and its files stay on your Mac.",
    });
    await A.service.deletePond(made.id);
    expect(removed).toEqual(["p1"]);
    expect(await A.service.list()).toEqual([]);
    expect(A.service.hasPondForProject({ projectId: "p1" })).toBe(false);
    // Adding the folder again later simply makes a Pond again.
    expect(A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).not.toBe(made.id);
  });

  it("a busy chat refuses with the host's sentence, the Pond stays, and Try again works once it is done", async () => {
    const c = new Cloud();
    let busy = true;
    const A = c.mac("Sibhi", {
      owner: true,
      removeProject: async () => {
        if (busy)
          throw Object.assign(new Error("A chat is still working or waiting on you here. Finish or stop it first."), {
            status: 409,
          });
      },
    });
    const made = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    await expect(A.service.deletePond(made.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/still working or waiting on you/),
    });
    const [row] = await A.service.list();
    expect(row!.ending).toMatchObject({ kind: "delete", failed: expect.stringMatching(/Finish or stop it first/) });
    busy = false;
    await A.service.deletePond(made.id);
    expect(await A.service.list()).toEqual([]);
  });
});

describe("Delete on a shared Pond (the service)", () => {
  it("a relay failure leaves it 'couldn't finish', nothing is swallowed, and it resumes and finishes on retry", async () => {
    const c = new Cloud();
    let down = true;
    const deleted: string[] = [];
    const relay = {
      deletePond: async (id: string) => {
        if (down) throw new RelayRefused(503);
        deleted.push(id);
      },
    };
    const A = c.mac("Sibhi", { owner: true, relay });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    await admitMember(A.service, B.service, pond.id, "member");
    expect(c.forPond(pond.id).length).toBeGreaterThan(0);

    await expect(A.service.deletePond(pond.id)).rejects.toThrow(/couldn't end the Pond in the cloud/);
    const [row] = await A.service.list();
    expect(row!.ending).toMatchObject({ kind: "delete", failed: expect.stringMatching(/cloud/) });
    expect(row!.endOffer!.primary).toBe("delete");
    // Still there: the cloud step comes before anything local.
    expect(c.forPond(pond.id).length).toBeGreaterThan(0);

    // A restart carries it on once the cloud answers.
    down = false;
    const again = c.mac("Sibhi", { owner: true, dir: A.dir, relay });
    await again.service.resumeEndings();
    expect(deleted).toEqual([pond.id]);
    expect(await again.service.list()).toEqual([]);
    expect(c.forPond(pond.id)).toEqual([]);
  });

  it("a document that cannot be deleted is not skipped: the Pond stays 'Deleting…' and the retry finishes it", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    await A.service.ripple(pond.id, "hello", undefined, "created").catch(() => undefined);
    c.failDeletes = true;
    await expect(A.service.deletePond(pond.id)).rejects.toThrow();
    expect((await A.service.list()).map((p) => p.ending?.kind)).toEqual(["delete"]);
    c.failDeletes = false;
    await A.service.deletePond(pond.id);
    expect(await A.service.list()).toEqual([]);
    expect(c.forPond(pond.id)).toEqual([]);
  });

  it("an end the relay already did (the web asked first: 404) counts as done", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", {
      owner: true,
      relay: {
        deletePond: async () => {
          throw new RelayRefused(404);
        },
      },
    });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    await A.service.deletePond(pond.id);
    expect(await A.service.list()).toEqual([]);
  });
});

describe("Leave and Remove a Member (the service)", () => {
  it("a Member's leave the cloud did not confirm is 'couldn't finish' on the row, and the retry completes it", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    let down = true;
    const B = c.mac("Aarav", {
      relay: {
        leaveAccountPond: async () => {
          if (down) throw new RelayRefused(503);
        },
      },
    });
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    expect(B.service.endOffer(pond.id)!.primary).toBe("leave");
    await expect(B.service.leave(pond.id)).rejects.toThrow(/couldn't confirm leaving/);
    expect((await B.service.list())[0]!.ending).toMatchObject({ kind: "leave", failed: expect.any(String) });
    down = false;
    await B.service.leave(pond.id);
    expect(await B.service.list()).toEqual([]);
  });

  it("removing a Member whose account index call fails is retried, not swallowed", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    const doc = await admitMember(A.service, B.service, pond.id, "member", { id: "acct-b" });
    const spy = vi.spyOn(A.service as unknown as { indexAccounts: () => Promise<void> }, "indexAccounts");
    spy.mockRejectedValue(new Error("relay down"));
    await expect(A.service.removeMember(pond.id, doc.id)).rejects.toThrow(
      /Couldn't finish removing them from Greenroom/,
    );
    // The member is out already; the retry settles the index and does not answer "No such member".
    spy.mockResolvedValue(undefined);
    await A.service.removeMember(pond.id, doc.id);
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), [], ["acct-b"]);
    await expect(A.service.removeMember(pond.id, doc.id)).rejects.toThrow(/No such member/);
  });
});

describe("Remove from Squeak (the service)", () => {
  it("a shared Pond is ended (deleted for everyone) before the project goes; the sentence says so", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Alpha", projectId: "p1" });
    const B = c.mac("Aarav");
    await admitMember(A.service, B.service, pond.id, "member");
    expect(A.service.projectRemovalBlock("p1")).toMatch(/Removing Alpha from Squeak deletes the Pond for everyone/);
    await A.service.endProjectPond("p1");
    expect(await A.service.list()).toEqual([]);
    expect(c.forPond(pond.id)).toEqual([]);
    A.service.projectRemoved("p1");
    expect(A.service.projectRemovalBlock("p1")).toBeNull();
  });

  it("a local Pond has nothing to end and goes with the project", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", { owner: true });
    A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(A.service.projectRemovalBlock("p1")).toBeNull();
    await A.service.endProjectPond("p1");
    A.service.projectRemoved("p1");
    expect(await A.service.list()).toEqual([]);
  });
});

describe("Invite shares first (the service)", () => {
  function relayWith(options: { failShare?: boolean } = {}) {
    const calls: string[] = [];
    let failShare = options.failShare ?? false;
    const port: PondInvites = {
      async ensurePond(_id, name) {
        calls.push(`share ${name}`);
        if (failShare) throw new InviteRefused("Squeak could not reach the cloud. Try again.", 503);
        return "shared";
      },
      async create(_id, input) {
        calls.push(`create ${input.pondName ?? "-"}`);
        return input.emails.map((email) => ({
          email,
          ok: true as const,
          status: "invited" as const,
          invite: {
            id: "i1",
            email,
            role: input.role,
            state: "pending" as const,
            invitedBy: "me",
            createdAt: 1,
            expiresAt: 2,
            settledAt: 0,
          },
        }));
      },
      list: async () => [],
      resend: async () => {
        throw new Error("unused");
      },
      withdraw: async () => {
        throw new Error("unused");
      },
      again: async () => {
        throw new Error("unused");
      },
    };
    return { port, calls, heal: () => void (failShare = false) };
  }

  it("a local Pond with no Ducks and no cloud record is shared, then invited, and reads shared", async () => {
    const c = new Cloud();
    const r = relayWith();
    const A = c.mac("Sibhi", { owner: true, invites: r.port });
    const made = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(A.service.sharingOf(made.id)).toBe("local");
    expect((await A.service.list())[0]).toMatchObject({ sharing: "local" });
    await A.service.inviteEmails(made.id, ["asha@example.com"], "member");
    expect(r.calls).toEqual(["share Alpha", "create -"]);
    expect(A.service.sharingOf(made.id)).toBe("shared");
    expect((await A.service.list())[0]).toMatchObject({ sharing: "shared" });
  });

  it("a share that fails at the relay is 'sharing', keeps the Pond's id, and resumes on the next invite", async () => {
    const c = new Cloud();
    const r = relayWith({ failShare: true });
    const A = c.mac("Sibhi", { owner: true, invites: r.port });
    const made = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    await expect(A.service.inviteEmails(made.id, ["asha@example.com"], "member")).rejects.toThrow(/could not reach/);
    expect(A.service.sharingOf(made.id)).toBe("sharing");
    expect(r.calls).toEqual(["share Alpha"]);
    r.heal();
    await A.service.inviteEmails(made.id, ["asha@example.com"], "member");
    expect(A.service.sharingOf(made.id)).toBe("shared");
    expect((await A.service.list()).map((p) => p.id)).toEqual([made.id]);
  });

  it("a relay without the share route is told the Pond's name by the first invite, as before", async () => {
    const c = new Cloud();
    const r = relayWith();
    r.port.ensurePond = async () => "unsupported";
    const A = c.mac("Sibhi", { owner: true, invites: r.port });
    const made = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    await A.service.inviteEmails(made.id, ["asha@example.com"], "member");
    expect(r.calls).toEqual(["create Alpha"]);
  });

  it("a Member cannot share the Pond", async () => {
    const c = new Cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    await expect(B.service.share(pond.id)).rejects.toThrow(/Only an owner/);
  });
});

// A step is only a step: the names are part of the contract the port is written against.
const _steps: EndStep[] = ["remove", "tell", "revoke", "cloud", "documents", "owner", "forget"];
void _steps;
