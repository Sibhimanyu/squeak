import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  answeringLine,
  changedLine,
  composerBlock,
  flockLine,
  foldEvents,
  groupThreads,
  pendingSends,
  pondLine,
  stateMark,
  toolsLine,
  workingRow,
} from "../js/guest-model.js";
import { startGuest } from "../js/guest.js";
import { KeyStore } from "../js/key-store.js";
import { all, click, installDom, text } from "./fake-dom.js";
import { account, cleanup, fakeRelay, mac } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

afterAll(cleanup);

const thread = (id, state, updatedAt, title = id) => ({ id, state, updatedAt, title });

describe("what the guest screens say", () => {
  it("groups threads Needs you, Working, Done, newest first, leaving empty groups out", () => {
    const groups = groupThreads([
      thread("a", "idle", 5),
      thread("b", "working", 9),
      thread("c", "idle", 8),
      thread("d", "error", 8, "Aaa"),
      thread("e", "waiting", 1),
    ]);
    expect(groups.map((g) => [g.title, g.threads.map((t) => t.id)])).toEqual([
      ["Needs you", ["e"]],
      ["Working", ["b"]],
      ["Done", ["d", "c", "a"]],
    ]);
    expect(groupThreads([thread("a", "working", 1)]).map((g) => g.title)).toEqual(["Working"]);
  });

  it("marks states: working, waiting, failed, and nothing when finished", () => {
    expect(stateMark("working").kind).toBe("working");
    expect(stateMark("waiting")).toEqual({ kind: "waiting", word: "Waiting for you" });
    expect(stateMark("error").kind).toBe("failed");
    expect(stateMark("idle").kind).toBeNull();
  });

  it("describes the flock without the word Member, and says who is on the web", () => {
    const ts = [{ id: "t1", title: "Fix login" }];
    expect(flockLine({ online: true, viewing: "t1", role: "member", nest: "sibhi-mac" }, ts)).toBe(
      "Viewing Fix login · sibhi-mac",
    );
    expect(flockLine({ online: true, role: "viewer", nest: null }, ts)).toBe("Online · Viewer · On the web");
    expect(flockLine({ online: false, role: "owner", nest: "m" }, ts)).toBe("Away · Owner · m");
    expect(pondLine({ members: [1, 2, 3], threads: [1] })).toBe("3 in the flock · 1 thread");
  });

  it("says who is answering only when it is someone else", () => {
    const holds = [{ requestId: "q", by: "x", byName: "Aarav" }];
    expect(answeringLine(holds, "q", "me")).toBe("Aarav is answering");
    expect(answeringLine(holds, "q", "x")).toBeNull();
    expect(answeringLine(holds, "other", "me")).toBeNull();
  });

  it("blocks the composer for a viewer, and when the chat skips approvals", () => {
    expect(composerBlock("viewer", {})).toMatch(/read but not send/);
    expect(composerBlock("member", { permissionMode: "bypassPermissions", starterName: "Sibhi" })).toMatch(
      /Only Sibhi can message this thread while it runs without asking/,
    );
    expect(composerBlock("member", { permissionMode: "default" })).toBeNull();
  });

  it("folds events into rows: tool steps group, a question closes when resolved, an approval stays read-only", () => {
    const events = [
      { seq: 1, at: 1, type: "user", by: "me", byName: "Webby", text: "go" },
      { seq: 2, at: 2, type: "tool", label: "Edit a.ts", state: "running", id: "t1" },
      { seq: 3, at: 3, type: "tool", label: "Edit a.ts", state: "done", id: "t1" },
      { seq: 4, at: 4, type: "tool", label: "Run tests", state: "running", id: "t2" },
      { seq: 5, at: 5, type: "question", requestId: "q", text: "Which?", options: ["A", "B"] },
      { seq: 6, at: 6, type: "approval", requestId: "a", label: "Run rm" },
      { seq: 7, at: 7, type: "resolved", requestId: "q" },
      { seq: 8, at: 8, type: "changed", files: 4, added: 120, removed: 30 },
      { seq: 9, at: 9, type: "state", state: "working" },
    ];
    const { rows, state } = foldEvents(events, "me");
    expect(state).toBe("working");
    expect(rows.map((r) => r.kind)).toEqual(["user", "tools", "question", "approval", "changed"]);
    expect(rows[0]).toMatchObject({ mine: true, who: "Webby" });
    expect(rows[1].steps).toEqual([
      { id: "t1", label: "Edit a.ts", state: "done" },
      { id: "t2", label: "Run tests", state: "running" },
    ]);
    expect(toolsLine(rows[1])).toBe("Run tests");
    expect(rows[2].open).toBe(false);
    expect(rows[3].open).toBe(true);
    expect(changedLine(rows[4])).toBe("Changed 4 files, +120 −30");
    expect(workingRow(rows, "working")).toBe("Running tests…");
    expect(workingRow(rows, "idle")).toBeNull();
  });

  it("keeps a send visible until a newer message with its words arrives", () => {
    const sends = [{ text: "ok", at: 1000, after: 5 }];
    const old = [{ type: "user", seq: 3, text: "ok" }];
    expect(pendingSends(sends, old, 2000)).toHaveLength(1);
    expect(pendingSends(sends, [...old, { type: "user", seq: 6, text: "ok" }], 2000)).toHaveLength(0);
    expect(pendingSends(sends, old, 1000 + 91_000)[0].unconfirmed).toBe(true);
    expect(pendingSends([{ ...sends[0], failed: true }], old, 1001)[0].unconfirmed).toBe(true);
  });
});

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out; screen says: ${check.screen?.() ?? ""}`);
};

class FakeSocket {
  constructor() {
    this.sent = [];
  }
  send(t) {
    this.sent.push(t);
  }
  close() {}
}

describe("the guest page, end to end over the fake relay", () => {
  const ORIGIN = "https://squeak.catalystserverless.in";
  const relay = fakeRelay();
  const owner = mac(relay, "Sibhi", { owner: true });
  let pondId;
  let link;
  let started;
  let root;
  const sockets = [];
  const replaced = [];

  beforeAll(async () => {
    installDom();
    pondId = (await owner.createPond({ name: "Site", projectId: "proj-site" })).id;
    link = (await owner.invite(pondId, "member")).link;
    root = document.createElement("div");
    const code = link.slice(link.indexOf("#"));
    const win = {
      location: { hash: code, origin: ORIGIN, pathname: "/app/join.html", search: "" },
      history: { state: null, replaceState: (...a) => replaced.push(a), pushState: () => undefined },
      addEventListener: () => undefined,
      document: { visibilityState: "visible", addEventListener: () => undefined },
    };
    started = startGuest({
      root,
      win,
      vault: new KeyStore(fakeIndexedDB()),
      fetch: (url, init) => {
        // The page's own /me: the relay says who the session cookie is, and the join carries the same account.
        const href = new URL(url, ORIGIN).href;
        if (href.endsWith("/me"))
          return Promise.resolve(new Response(JSON.stringify(account("Webby")), { status: 200 }));
        return relay.as(account("Webby")).fetch(href, init);
      },
      socket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      minGapMs: 0,
    });
    await started;
  });

  const says = (needle) => {
    const check = () => text(root).includes(needle);
    check.screen = () => text(root);
    return until(check);
  };
  const notice = () => {
    for (const s of sockets)
      s.onmessage?.({
        data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { streamingId: 1, data: "{}" } } }),
      });
  };
  const buttons = () => all(root).filter((n) => n.tag === "button");
  const press = (label) => click(buttons().find((b) => text(b).includes(label)));

  it("says who they join as (no name box), never keeps the fragment in the address bar, and waits for the owner", async () => {
    expect(replaced).toEqual([[null, "", "/app/join.html"]]);
    expect(text(root)).toContain("You'll join as Webby (webby@x.org)");
    expect(all(root).some((n) => n.tag === "input")).toBe(false);
    press("Join");
    await says("Waiting for Sibhi to let you in");
    // The page survives closing, so it says so (it used to say "keep this page open"), and Cancel says what it does.
    expect(text(root)).toContain("You can close this tab");
    expect(text(root)).not.toContain("Keep this page open");
    expect(text(root)).toContain("Withdraw my request");
  });

  it("shows the pond, the flock and its shared threads once let in", async () => {
    const t = await owner.publishThread(pondId, {
      sessionId: "s1",
      title: "Fix the login bug",
      agent: "claude",
      model: "opus",
      mode: "shared",
    });
    const [request] = (await owner.view(pondId)).joins;
    await owner.decideJoin(pondId, request.requestId, { approve: true });
    notice();
    await says("Fix the login bug");
    expect(text(root)).toContain("Site");
    expect(text(root)).toContain("Webby (you)");
    expect(text(root)).toContain("Sibhi");
    expect(text(root)).toContain("Online · On the web");
    expect(text(root)).toContain("Sibhi · Claude");
    root.threadId = t.id;
  });

  it("opens a thread: the conversation, a question, an approval that cannot be answered, no stop", async () => {
    const id = root.threadId;
    const first = owner.allocSeq(pondId, id, 4);
    await owner.publishEvents(pondId, id, [
      { seq: first, at: 1, type: "user", by: owner.me.id, byName: "Sibhi", text: "fix the login" },
      { seq: first + 1, at: 2, type: "agent", text: "Looking at it" },
      {
        seq: first + 2,
        at: 3,
        type: "question",
        requestId: "q1",
        text: "Which approach?",
        options: ["Patch", "Rewrite"],
      },
      { seq: first + 3, at: 4, type: "approval", requestId: "a1", label: "Run npm test" },
    ]);
    click(buttons().find((b) => text(b).includes("Fix the login bug")));
    notice();
    await says("Which approach?");
    expect(text(root)).toContain("fix the login");
    expect(text(root)).toContain("Looking at it");
    expect(text(root)).toContain("Waiting for Sibhi to approve");
    const labels = buttons().map((b) => text(b).trim());
    expect(labels).toEqual(expect.arrayContaining(["Patch", "Rewrite", "Answer", "Send"]));
    expect(labels.some((l) => /stop|approve|allow|deny/i.test(l))).toBe(false);
  });

  it("sends a message the Mac verifies and runs", async () => {
    const box = all(root).find((n) => n.tag === "textarea");
    box.value = "Also add a test";
    press("Send");
    await says("Also add a test");
    await until(async () => {
      const ran = [];
      await owner.processCommands(pondId, async ({ cmd, from }) => void ran.push([cmd.kind, cmd.text, from.name]));
      if (ran.length) {
        expect(ran).toEqual([["message", "Also add a test", "Webby"]]);
        return true;
      }
      return false;
    });
  });

  it("shows who is answering when the starter holds the question, and disables answering", async () => {
    await owner.hold(pondId, "q1");
    notice();
    await says("Sibhi is answering");
    const patch = buttons().find((b) => text(b).trim() === "Patch");
    expect(patch.disabled).toBe(true);
  });

  it("answers a free question after the hold lapses, with a hold of its own", async () => {
    await owner.releaseHold(pondId, "q1");
    notice();
    await until(() => !text(root).includes("Sibhi is answering"));
    press("Rewrite");
    await says("Sent. Waiting for the thread's starter");
    const seen = [];
    await until(async () => {
      await owner.processCommands(pondId, async ({ cmd }) => void seen.push(cmd));
      return seen.length > 0;
    });
    expect(seen[0]).toMatchObject({ kind: "answer", requestId: "q1", answer: "Rewrite" });
  });

  it("when the owner removes the guest, the page says so", async () => {
    const me = (await owner.view(pondId)).members.find((m) => m.name === "Webby");
    await owner.removeMember(pondId, me.id);
    notice();
    await says("You're no longer in Site");
  });
});
