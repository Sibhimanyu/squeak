import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeHostError } from "../native/client.js";
import { checkAnswers, describeRequest, NativePhone } from "./native-phone.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("describeRequest", () => {
  it("clips a plan and names a tool's command or path, never the whole input", () => {
    const plan = describeRequest({ id: "r", kind: "plan", summary: "s" }, { input: { plan: "p".repeat(5000) } });
    expect(plan.plan).toHaveLength(2000);
    expect(plan.chatRule).toBe(false);
    const tool = describeRequest(
      { id: "r", kind: "tool", summary: "s" },
      { toolName: "Bash", input: { command: "ls", secret: "no" } },
    );
    expect(tool).toMatchObject({ tool: "Bash", command: "ls", chatRule: true });
    expect(JSON.stringify(tool)).not.toContain("secret");
  });

  it("lists a question's options, at most eight", () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `o${i}` }));
    const out = describeRequest(
      { id: "r", kind: "question", summary: "s" },
      { input: { questions: [{ question: "Q?", options }] } },
    );
    expect(out.questions?.[0]?.options).toHaveLength(8);
  });
});

describe("checkAnswers", () => {
  const payload = {
    input: { questions: [{ question: "Pick", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] },
  };
  it("allows a joined multi-select and nothing outside the options", () => {
    expect(checkAnswers(payload, [{ question: 0, picked: "A, B" }])).toEqual({ ok: true, answers: { Pick: "A, B" } });
    expect(checkAnswers(payload, [{ question: 0, picked: "A, C" }])).toEqual({ ok: false });
  });
});

describe("NativePhone", () => {
  it("takes the host's newest open request, and sends the token with every call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-phone-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "token"), "tok\n");
    const seen: Array<{ url: string; token: string | null }> = [];
    const phone = new NativePhone({
      dbPath: path.join(dir, "none.db"),
      baseUrl: "http://h",
      tokenPath: path.join(dir, "token"),
      models: () => [],
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, token: (init.headers as Record<string, string>)["x-squeak-token"] ?? null });
        return new Response(
          JSON.stringify({
            requests: [
              { id: "old", kind: "tool" },
              { id: "new", kind: "plan" },
            ],
          }),
          {
            status: 200,
          },
        );
      }) as unknown as typeof fetch,
    });
    expect(await phone.currentRequest("n1")).toMatchObject({ id: "new", kind: "plan" });
    expect(seen).toEqual([{ url: "http://h/native/sessions/n1/requests", token: "tok" }]);
    expect(phone.projects()).toEqual([]);
  });

  it("says the host is down without a token", async () => {
    const phone = new NativePhone({
      dbPath: "/nope",
      baseUrl: "http://h",
      tokenPath: "/nope/token",
      models: () => [],
    });
    await expect(phone.currentRequest("n1")).rejects.toBeInstanceOf(NativeHostError);
  });

  it("draws the host's directory as it comes: rows only, no keys, null when the host is down or old", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-phone-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "token"), "tok\n");
    const directory = {
      schema: 1,
      ponds: [
        {
          id: "proj-shop",
          kind: "project",
          name: "Shop",
          projectId: "proj-shop",
          pondId: "rec-1",
          shared: true,
          members: [{ name: "Asha", online: true }],
          hidden: true,
          colour: "teal",
          labels: ["x"],
          streams: [{ id: "w3", name: "Cart", branch: "cart" }],
          archivedStreams: 1,
          counts: { threads: 0, needsYou: 0, working: 0 },
          folder: "/p/shop",
        },
        {
          id: "rec-j",
          kind: "joined",
          name: "Theirs",
          pondId: "rec-j",
          shared: false,
          members: [],
          streams: [],
          counts: { threads: 0, needsYou: 0, working: 0 },
        },
      ],
      order: { mode: "newest", ids: [] },
      threads: {},
      other: [],
    };
    const make = (down: boolean, body: unknown = directory) =>
      new NativePhone({
        dbPath: path.join(dir, "none.db"),
        baseUrl: "http://h",
        tokenPath: path.join(dir, "token"),
        models: () => [],
        fetch: (async () => {
          if (down) throw new TypeError("refused");
          return new Response(JSON.stringify(body), { status: 200 });
        }) as unknown as typeof fetch,
      });
    const ponds = (await make(false).ponds())!;
    expect(ponds.map((p) => [p.id, p.kind, p.projectId, p.pondId])).toEqual([
      ["proj-shop", "project", "proj-shop", "rec-1"],
      ["rec-j", "joined", undefined, "rec-j"],
    ]);
    expect(ponds[0]).toMatchObject({
      shared: true,
      hidden: true,
      colour: "teal",
      labels: ["x"],
      archivedStreams: 1,
      folder: "/p/shop",
      streams: [{ id: "w3", name: "Cart", branch: "cart" }],
    });
    expect(await make(true).ponds()).toBeNull();
    expect(await make(false, { error: "not found" }).ponds()).toBeNull();
  });

  it("reads the order and a pond's page from the host's own routes, and writes through them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-phone-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "token"), "tok\n");
    const sent: Array<[string, string, unknown]> = [];
    const phone = new NativePhone({
      dbPath: path.join(dir, "none.db"),
      baseUrl: "http://h",
      tokenPath: path.join(dir, "token"),
      models: () => [],
      fetch: (async (url: string, init?: RequestInit) => {
        const route = url.replace("http://h", "");
        sent.push([init?.method ?? "GET", route, init?.body ? JSON.parse(String(init.body)) : undefined]);
        const bodies: Record<string, unknown> = {
          "/native/pond-order": { mode: "recent", order: ["proj"] },
          "/native/ponds/a": {
            invites: [
              { role: "editor", state: "pending", expiresAt: 1_700_000_000_000, code: "SECRET" },
              { role: "viewer", state: "accepted", expiresAt: 1 },
            ],
            joins: [{ name: "Ravi", verifiedEmail: "r@x.y" }],
            ripples: [
              { text: "started", at: 1_700_000_000_000, actorName: "Asha" },
              { text: "joined", at: 1_700_000_100_000 },
            ],
          },
        };
        return new Response(JSON.stringify(bodies[route] ?? {}), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await phone.pondOrder()).toEqual({ mode: "newest", ids: ["proj"] });
    const detail = await phone.pondDetail("a");
    expect(detail).toEqual({
      id: "a",
      invites: [{ label: "editor invite", expiresAt: new Date(1_700_000_000_000).toISOString() }],
      waiting: [{ name: "Ravi" }],
      ripples: [
        { text: "joined", at: new Date(1_700_000_100_000).toISOString() },
        { text: "started", at: new Date(1_700_000_000_000).toISOString(), who: "Asha" },
      ],
    });
    expect(JSON.stringify(detail)).not.toMatch(/SECRET|r@x/);
    sent.length = 0;
    await phone.setPondHidden("proj", false);
    await phone.setPondOrder({ ids: ["proj"] });
    await phone.setPondOrder({ mode: "newest" });
    expect(sent).toEqual([
      ["PATCH", "/native/projects/proj/prefs", { hidden: false }],
      ["PUT", "/native/pond-order", { mode: "manual", order: ["proj"] }],
      ["PUT", "/native/pond-order", { mode: "recent" }],
    ]);
  });
});

describe("NativePhone project icons", () => {
  const make = (projects: unknown[], opts: { down?: boolean; shrink?: (b: Buffer) => Promise<Buffer | null> } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-phone-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "token"), "tok\n");
    const calls: string[] = [];
    const phone = new NativePhone({
      dbPath: path.join(dir, "none.db"),
      baseUrl: "http://h",
      tokenPath: path.join(dir, "token"),
      models: () => [],
      shrink: opts.shrink ?? (async (b) => b),
      fetch: (async (url: string) => {
        calls.push(url);
        if (opts.down) throw new TypeError("refused");
        if (url.endsWith("/icon")) return new Response(Buffer.from("png-" + url), { status: 200 });
        return new Response(JSON.stringify({ projects }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { phone, calls };
  };
  const proj = (id: string, name: string, at = 1) => ({
    id,
    name,
    iconUrl: `/native/projects/${id}/icon`,
    iconUpdatedAt: at,
  });

  it("keys each icon by name and by id, skips projects without one, and caches by mtime", async () => {
    const { phone, calls } = make([proj("p1", "Shop"), { id: "p2", name: "Blog" }]);
    const icons = await phone.projectIcons();
    const b64 = Buffer.from("png-http://h/native/projects/p1/icon").toString("base64");
    expect(icons).toEqual({ p1: b64, Shop: b64 });
    await phone.projectIcons();
    expect(calls.filter((c) => c.endsWith("/icon"))).toHaveLength(1);
  });

  it("is null when the host is down, and leaves out an icon that cannot be shrunk or is too big", async () => {
    expect(await make([], { down: true }).phone.projectIcons()).toBeNull();
    expect(await make([proj("p1", "A")], { shrink: async () => null }).phone.projectIcons()).toEqual({});
    expect(await make([proj("p1", "A")], { shrink: async () => Buffer.alloc(30_000) }).phone.projectIcons()).toEqual(
      {},
    );
  });

  it("caps the icons at 40", async () => {
    const list = Array.from({ length: 60 }, (_, i) => proj(`p${i}`, `N${i}`));
    const icons = await make(list).phone.projectIcons();
    expect(Object.keys(icons ?? {})).toHaveLength(80);
  });
});
