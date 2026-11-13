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

  it("lists ponds as names and online flags only, and null when the host is down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-phone-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "token"), "tok\n");
    const make = (down: boolean) =>
      new NativePhone({
        dbPath: path.join(dir, "none.db"),
        baseUrl: "http://h",
        tokenPath: path.join(dir, "token"),
        models: () => [],
        fetch: (async (url: string) => {
          if (down) throw new TypeError("refused");
          const body = url.endsWith("/native/ponds")
            ? {
                ponds: [
                  { id: "a", name: "Shop", memberCount: 2, local: false, role: "owner", gitRemote: "git@x:y.git" },
                  { id: "b", name: "Docs", memberCount: 1, local: true },
                ],
              }
            : {
                members: [
                  { id: "m1", name: "Asha", online: true, nest: "n", role: "owner", you: true },
                  { id: "m2", name: "Dev", online: false },
                ],
                joins: [{ verifiedEmail: "x@y.z" }],
              };
          return new Response(JSON.stringify(body), { status: 200 });
        }) as unknown as typeof fetch,
      });
    const ponds = await make(false).ponds();
    expect(ponds).toEqual([
      {
        id: "a",
        name: "Shop",
        shared: true,
        members: [
          { name: "Asha", online: true },
          { name: "Dev", online: false },
        ],
        match: "shop",
      },
      { id: "b", name: "Docs", shared: false, members: [], match: "docs" },
    ]);
    expect(JSON.stringify(ponds)).not.toMatch(/m1|git@|x@y|nest/);
    expect(await make(true).ponds()).toBeNull();
  });

  it("reads prefs, streams, order and a pond's page from the host's own routes, and writes through them", async () => {
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
          "/native/ponds": { ponds: [{ id: "a", name: "Shop", local: true, projectId: "proj" }] },
          "/native/projects": { projects: [{ id: "proj", name: "Shop", hidden: true, labels: ["x"], colour: "teal" }] },
          "/native/projects/proj/workspaces": {
            workspaces: [
              { id: "w1", name: "old", title: "Old", branch: "old", state: "archived", createdAt: "2026-01-01" },
              { id: "w2", name: "mid", title: "Checkout", branch: "co", state: "ready", createdAt: "2026-02-01" },
              { id: "w3", name: "new", title: "Cart", branch: "cart", state: "ready", createdAt: "2026-03-01" },
            ],
          },
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
    const [pond] = (await phone.ponds())!;
    expect(pond).toMatchObject({ hidden: true, colour: "teal", labels: ["x"], archivedStreams: 1, projectId: "proj" });
    expect(pond!.streams!.map((s) => s.id)).toEqual(["w3", "w2"]);
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
