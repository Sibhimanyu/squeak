import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalystSetup, type CatalystSetupDeps } from "./catalyst-setup.js";

type Run = NonNullable<CatalystSetupDeps["run"]>;
const BANNER = "\u001b[33m┌──┐\u001b[39m\n\u001b[33m│ Security warning │\u001b[39m\n";
const ok = (stdout: string) => ({ code: 0, stdout: BANNER + stdout, stderr: "" });

const RELAY_SRC = path.resolve(import.meta.dirname, "../../cloud/catalyst-relay");
let dir: string;
let calls: Array<{ cmd: string; args: string[]; cwd?: string }>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "catalyst-setup-"));
  calls = [];
  process.env["SQUEAK_CATALYST_RELAY_DIR"] = RELAY_SRC;
});
afterEach(() => {
  delete process.env["SQUEAK_CATALYST_RELAY_DIR"];
});

const RC = (id: string, name: string) =>
  JSON.stringify({
    defaults: { project: 1, env: 1 },
    projects: [{ idx: 1, id, name, domain: { id: "5", name: `${name}-600.development` }, env: [{ id: "600" }] }],
  });

/** A fake CLI: logged in, three projects, `init -p` writes a .catalystrc, deploys succeed. */
function cli(over: Partial<Record<"version" | "whoami" | "init" | "deploy" | "npm", () => ReturnType<Run>>> = {}): Run {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    const a = args.join(" ");
    if (a === "--version") return (over.version ?? (async () => ok("1.29.1\n")))();
    if (a === "whoami") return (over.whoami ?? (async () => ok("✔ Logged as: Sam G undefined\n")))();
    if (a === "init -ni")
      return (
        over.init?.() ?? {
          code: 1,
          stdout:
            "✖ Error: requires the ProjectId\n\nThe following orgs are available:\n* squeak-trial(53069000000273389)\n* imago(53069000000188101)\n",
          stderr: "",
        }
      );
    if (args[0] === "init" && args[1] === "-p") {
      writeFileSync(path.join(opts.cwd!, ".catalystrc"), RC(args[2]!, "squeak-trial"));
      return ok("✔ Catalyst initialization complete!\n");
    }
    if (cmd === "npm") return (over.npm ?? (async () => ok("")))();
    if (args[0] === "deploy") return (over.deploy ?? (async () => ok("deployed\n")))();
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

const make = (run: Run, fetchImpl?: typeof fetch) =>
  new CatalystSetup({ supportDir: dir, run, ...(fetchImpl ? { fetch: fetchImpl } : {}) });

describe("cliStatus", () => {
  it("reads the version past the banner and the signed-in name", async () => {
    expect(await make(cli()).cliStatus()).toEqual({ installed: true, version: "1.29.1", loggedIn: true, org: "Sam G" });
  });
  it("says not installed when the command fails or prints no version", async () => {
    const run = cli({ version: async () => ({ code: 127, stdout: "", stderr: "not found" }) });
    expect(await make(run).cliStatus()).toEqual({ installed: false, loggedIn: false });
  });
  it("says not signed in when whoami has no identity", async () => {
    const run = cli({ whoami: async () => ({ code: 1, stdout: "", stderr: "Please login" }) });
    expect(await make(run).cliStatus()).toEqual({ installed: true, version: "1.29.1", loggedIn: false });
  });
});

describe("listProjects", () => {
  it("parses the `* name(id)` lines from init -ni, in a scratch dir that is removed", async () => {
    const list = await make(cli()).listProjects();
    expect(list).toEqual([
      { id: "53069000000273389", name: "squeak-trial" },
      { id: "53069000000188101", name: "imago" },
    ]);
    expect(calls[0]!.args).toEqual(["init", "-ni"]);
    expect(existsSync(calls[0]!.cwd!)).toBe(false);
  });
  it("returns an empty list when the CLI lists nothing", async () => {
    const run = cli({ init: async () => ({ code: 1, stdout: "Please login", stderr: "" }) });
    expect(await make(run).listProjects()).toEqual([]);
  });
});

describe("selectProject", () => {
  it("links the private dir, records name and the development app URL for the DC", async () => {
    const s = make(cli());
    const config = await s.selectProject("53069000000273389");
    expect(config).toMatchObject({
      projectId: "53069000000273389",
      projectName: "squeak-trial",
      dc: "in",
      appUrl: "https://squeak-trial-600.development.catalystserverless.in",
      deployedVersion: null,
    });
    expect(calls[0]).toMatchObject({ cmd: "catalyst", args: ["init", "-p", "53069000000273389", "-ni"] });
    expect(calls[0]!.cwd).toBe(path.join(dir, "catalyst-relay"));
  });
  it("uses the configured data centre's domain", async () => {
    const s = make(cli());
    s.setConfig({ dc: "us" });
    expect((await s.selectProject("53069000000273389")).appUrl).toMatch(/\.catalystserverless\.com$/);
  });
  it("refuses a malformed id and a failed init with fixed sentences", async () => {
    await expect(make(cli()).selectProject("abc; rm -rf")).rejects.toThrow("That is not a Catalyst project id.");
    const run: Run = async () => ({ code: 1, stdout: "secret output", stderr: "" });
    await expect(make(run).selectProject("53069000000273389")).rejects.toThrow(
      "Could not select that project. Check you are signed in to Catalyst.",
    );
  });
  it("forgets the deployed version when the project changes", async () => {
    const s = make(cli());
    s.setConfig({ projectId: "111111111", deployedVersion: "1.0.0" });
    expect((await s.selectProject("53069000000273389")).deployedVersion).toBeNull();
  });
});

describe("deploy", () => {
  it("needs a project", async () => {
    await expect(make(cli()).deploy()).rejects.toThrow("Pick a Catalyst project first.");
  });
  it("copies the relay, sets RELAY_KEY in its config, installs, deploys, records the version, keeps the key", async () => {
    const s = make(cli());
    await s.selectProject("53069000000273389");
    calls.length = 0;
    const first = await s.deploy();
    expect(first.relayKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.deployedVersion).toBe(
      JSON.parse(readFileSync(path.join(RELAY_SRC, "functions/squeak_relay/package.json"), "utf8")).version,
    );

    const fnDir = path.join(dir, "catalyst-relay", "functions", "squeak_relay");
    const cfg = JSON.parse(readFileSync(path.join(fnDir, "catalyst-config.json"), "utf8"));
    expect(cfg.deployment.env_variables.RELAY_KEY).toBe(first.relayKey);
    expect(existsSync(path.join(dir, "catalyst-relay", "catalyst.json"))).toBe(true);
    expect(existsSync(path.join(dir, "catalyst-relay", ".catalystrc"))).toBe(true);
    expect(existsSync(path.join(dir, "catalyst-relay", "test"))).toBe(false);
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["npm", "ci", "--omit=dev", "--no-audit", "--no-fund"],
      ["catalyst", "deploy", "--only", "functions:squeak_relay", "-ni"],
    ]);
    expect(calls[1]!.cwd).toBe(path.join(dir, "catalyst-relay"));

    const second = await s.deploy();
    expect(second.relayKey).toBe(first.relayKey);
  });
  it("fails with fixed sentences that carry neither CLI output nor the key", async () => {
    const run = cli({ deploy: async () => ({ code: 1, stdout: "TOKEN=abc123", stderr: "boom" }) });
    const s = make(run);
    await s.selectProject("53069000000273389");
    const err = await s.deploy().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("The relay deploy failed. Check you are signed in and the project is selected.");
    expect(err?.message).not.toContain(s.config().relayKey!);
    expect(s.config().deployedVersion).toBeNull();
    const npmFail = make(cli({ npm: async () => ({ code: 1, stdout: "", stderr: "x" }) }));
    await npmFail.selectProject("53069000000273389");
    await expect(npmFail.deploy()).rejects.toThrow("Could not install the relay's dependencies.");
  });
});

describe("ping", () => {
  const withRelay = (s: CatalystSetup) =>
    s.setConfig({ appUrl: "https://p-600.development.catalystserverless.in", relayKey: "key123" });
  it("asks /ping with the key and maps the answer", async () => {
    let seen: { url: string; key: string | null } | null = null;
    const f = (async (url: string, init?: RequestInit) => {
      seen = { url, key: new Headers(init?.headers).get("x-squeak-relay") };
      return new Response(
        JSON.stringify({ ok: true, store: "ready", channel: "missing", channelId: "x", version: "1.0.0" }),
      );
    }) as unknown as typeof fetch;
    const s = make(cli(), f);
    withRelay(s);
    expect(await s.ping()).toEqual({ ok: true, store: "ready", channel: "missing", version: "1.0.0" });
    expect(seen).toEqual({
      url: "https://p-600.development.catalystserverless.in/server/squeak_relay/ping",
      key: "key123",
    });
  });
  it("is null without config, on a bad status, on a throw, and for a host that is not Catalyst's", async () => {
    expect(await make(cli()).ping()).toBeNull();
    const s401 = make(cli(), (async () => new Response("", { status: 401 })) as unknown as typeof fetch);
    withRelay(s401);
    expect(await s401.ping()).toBeNull();
    const sThrow = make(cli(), (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    withRelay(sThrow);
    expect(await sThrow.ping()).toBeNull();
    let called = false;
    const evil = make(cli(), (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch);
    evil.setConfig({ appUrl: "https://evil.example.com", relayKey: "k" });
    expect(await evil.ping()).toBeNull();
    expect(called).toBe(false);
  });
});

describe("steps", () => {
  const states = (steps: Awaited<ReturnType<CatalystSetup["steps"]>>) => steps.map((s) => `${s.id}:${s.state}`);
  const pingFetch = (body: object) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it("starts with everything after the CLI todo, with console URLs for the DC", async () => {
    const steps = await make(cli()).steps();
    expect(states(steps)).toEqual([
      "cli:done",
      "project:todo",
      "table:todo",
      "deploy:todo",
      "channel:todo",
      "verify:todo",
    ]);
    expect(steps.find((s) => s.id === "project")!.consoleUrl).toBe("https://console.catalyst.zoho.in/");
  });
  it("tells how to install and sign in", async () => {
    const none = await make(cli({ version: async () => ({ code: 127, stdout: "", stderr: "" }) })).steps();
    expect(none[0]).toMatchObject({ id: "cli", state: "todo" });
    expect(none[0]!.detail).toContain("npm i -g zcatalyst-cli");
    const out = await make(cli({ whoami: async () => ({ code: 1, stdout: "", stderr: "" }) })).steps();
    expect(out[0]!.detail).toBe("Sign in with catalyst login.");
  });
  it("asks for the domain when a project has none", async () => {
    const s = make(cli());
    s.setConfig({ projectId: "5555555" });
    expect((await s.steps())[1]).toMatchObject({ id: "project", state: "error" });
  });
  it("marks everything done from a ready, current relay (channel reported by /ping)", async () => {
    const version = JSON.parse(
      readFileSync(path.join(RELAY_SRC, "functions/squeak_relay/package.json"), "utf8"),
    ).version;
    const s = make(cli(), pingFetch({ ok: true, store: "ready", channel: "ready", version }));
    s.setConfig({
      projectId: "5555555",
      appUrl: "https://p.development.catalystserverless.in",
      relayKey: "k",
      deployedVersion: version,
    });
    expect(states(await s.steps())).toEqual([
      "cli:done",
      "project:done",
      "table:done",
      "deploy:done",
      "channel:done",
      "verify:todo",
    ]);
  });
  it("shows the missing table and channel separately, and an old relay", async () => {
    const s = make(cli(), pingFetch({ ok: true, store: "missing", channel: "ready", version: "0.0.1" }));
    s.setConfig({
      projectId: "5555555",
      appUrl: "https://p.development.catalystserverless.in",
      relayKey: "k",
      deployedVersion: "0.0.1",
    });
    const steps = await s.steps();
    expect(states(steps)).toEqual([
      "cli:done",
      "project:done",
      "table:todo",
      "deploy:todo",
      "channel:done",
      "verify:todo",
    ]);
    expect(steps[3]!.detail).toBe("The deployed relay is out of date. Deploy it again.");
  });
  it("errors the deploy step when a deployed relay stops answering", async () => {
    const s = make(cli(), (async () => new Response("", { status: 502 })) as unknown as typeof fetch);
    s.setConfig({
      projectId: "5555555",
      appUrl: "https://p.development.catalystserverless.in",
      relayKey: "k",
      deployedVersion: "1.0.0",
    });
    expect((await s.steps())[3]).toMatchObject({ id: "deploy", state: "error" });
  });
  it("shows working while a deploy runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = make(cli({ npm: async () => (await gate, ok("")) }));
    await s.selectProject("53069000000273389");
    const running = s.deploy();
    await new Promise((r) => setTimeout(r, 20));
    expect((await s.steps())[3]).toMatchObject({ id: "deploy", state: "working" });
    release();
    await running;
  });
  it("never puts the relay key in a step", async () => {
    const s = make(cli());
    s.setConfig({
      projectId: "5555555",
      appUrl: "https://p.development.catalystserverless.in",
      relayKey: "SECRET-KEY-VALUE",
    });
    expect(JSON.stringify(await s.steps())).not.toContain("SECRET-KEY-VALUE");
  });
});

describe("config", () => {
  it("defaults, persists in cloud.json's catalyst block at 0600, and keeps other blocks", () => {
    const s = make(cli());
    expect(s.config()).toEqual({
      projectId: null,
      projectName: null,
      dc: "in",
      appUrl: null,
      relayKey: null,
      deployedVersion: null,
    });
    writeFileSync(path.join(dir, "cloud.json"), JSON.stringify({ active: "firebase", firebase: { projectId: "f" } }));
    s.setConfig({ projectId: "42", appUrl: "https://x.catalystserverless.in" });
    s.setConfig({ dc: "eu" });
    const file = path.join(dir, "cloud.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.active).toBe("firebase");
    expect(saved.firebase).toEqual({ projectId: "f" });
    expect(saved.catalyst).toMatchObject({ projectId: "42", dc: "eu", appUrl: "https://x.catalystserverless.in" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(make(cli()).config().projectId).toBe("42");
  });
  it("survives a corrupt file", () => {
    writeFileSync(path.join(dir, "cloud.json"), "{nope");
    const s = make(cli());
    expect(s.config().dc).toBe("in");
    s.setConfig({ projectId: "1" });
    expect(s.config().projectId).toBe("1");
  });
});
