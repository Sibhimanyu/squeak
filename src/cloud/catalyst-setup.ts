/**
 * Catalyst setup: what the daemon's `/control/cloud/catalyst/*` routes call (docs/cloud-layer.md, "Catalyst setup
 * steps"). Everything that touches the Catalyst CLI goes through `deps.run`, so tests fake it; everything that
 * touches the relay goes through `deps.fetch`.
 *
 * API (exactly):
 *   new CatalystSetup({ supportDir, run?, fetch?, now? })
 *   cliStatus()            -> { installed, version?, loggedIn, org? }   (`catalyst --version`, `catalyst whoami`)
 *   listProjects()         -> [{ id, name }]
 *   selectProject(id)      -> CatalystConfig   (links <supportDir>/catalyst-relay to the project; records name, app URL)
 *   deploy()               -> CatalystConfig   (copies cloud/catalyst-relay, keeps or makes relayKey, sets RELAY_KEY,
 *                                               `catalyst deploy --only functions:squeak_relay`)
 *   ping()                 -> { ok, store, channel, version? } | null   (GET <appUrl>/server/squeak_relay/ping)
 *   steps()                -> the contract's six Steps, fixed-sentence details, console URLs for the DC
 *   config() / setConfig() -> the "catalyst" block of <supportDir>/cloud.json (0600, atomic, other blocks kept)
 * Failures throw `CatalystSetupError` whose message is a fixed sentence: never CLI output, never the relay key.
 * `verify` is reported todo here; the daemon marks it done from its own last test round trip.
 *
 * What is verified against the real CLI (1.29.1) and what is assumed:
 *  - verified: `catalyst --version` prints the version after a banner box; `catalyst whoami` prints
 *    "Logged as: <name> ..."; `catalyst project:list` is INTERACTIVE (an org menu) outside a project, so it is not
 *    used; `catalyst init -ni` with no `-p` fails by design and lists the account's projects as `* name(id)` lines
 *    (the CLI mislabels them "orgs"); `catalyst init -p <id> -ni` works WITHOUT --org, writes only a local
 *    `.catalystrc` (no cloud change) holding the project's name, id and `domain.name`
 *    (`<project>-<orgId>.development`). That is why selection uses `init`, not the interactive `project:use`.
 *  - how the app URL is found: `https://<domain.name>.catalystserverless.<tld>` (the development domain; tld by DC).
 *    The CLI does not say the data centre anywhere, so `dc` defaults to "in" and is settable via `setConfig`.
 *  - assumed (not run, deploying would change a real project): `catalyst deploy --only functions:squeak_relay -ni`
 *    from a directory holding `.catalystrc`, `catalyst.json` and `functions/squeak_relay`; env vars come from
 *    `deployment.env_variables` in the function's catalyst-config.json (the catalyst-basics skill: a deploy
 *    overwrites console-set variables, so the file is the only place that survives); the CLI uploads the function's
 *    `node_modules`, so `npm ci --omit=dev` runs there first.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CatalystSetupDeps {
  supportDir: string;
  run?: (
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetch?: typeof fetch;
  now?: () => number;
}

export type StepId = "cli" | "project" | "table" | "deploy" | "channel" | "verify";
export interface Step {
  id: StepId;
  state: "done" | "todo" | "working" | "error";
  detail?: string;
  consoleUrl?: string;
}
export interface CatalystConfig {
  projectId: string | null;
  projectName: string | null;
  dc: string;
  appUrl: string | null;
  relayKey: string | null;
  deployedVersion: string | null;
}

export class CatalystSetupError extends Error {}

/** Catalyst data centre -> top-level domain of its console and of `catalystserverless`. */
const TLD: Record<string, string> = { us: "com", in: "in", eu: "eu", au: "com.au", jp: "jp", ca: "ca", sa: "sa" };
const FUNCTION = "squeak_relay";
const CLI_TIMEOUT_MS = 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
/** `cloud/catalyst-relay`, found from this file (src/cloud or dist/cloud) unless SQUEAK_CATALYST_RELAY_DIR says. */
function relaySourceDir(): string {
  const fromEnv = process.env["SQUEAK_CATALYST_RELAY_DIR"];
  if (fromEnv) return fromEnv;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "cloud", "catalyst-relay");
    if (existsSync(path.join(candidate, "catalyst.json"))) return candidate;
    dir = path.dirname(dir);
  }
  return path.join(dir, "cloud", "catalyst-relay");
}

/** The real `run`: execFile with the places a Node-installed CLI lives added to PATH, no colour, no stdin. */
const defaultRun: NonNullable<CatalystSetupDeps["run"]> = (cmd, args, opts) =>
  new Promise((resolve) => {
    const extra = [
      path.join(homedir(), ".local", "bin"),
      path.join(homedir(), ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    const env = {
      ...process.env,
      NO_COLOR: "1",
      PATH: [...extra, process.env["PATH"] ?? ""].join(path.delimiter),
    };
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, env, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end();
  });

export class CatalystSetup {
  private readonly supportDir: string;
  private readonly run: NonNullable<CatalystSetupDeps["run"]>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private deploying = false;

  constructor(deps: CatalystSetupDeps) {
    this.supportDir = deps.supportDir;
    this.run = deps.run ?? defaultRun;
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private get cloudFile(): string {
    return path.join(this.supportDir, "cloud.json");
  }
  /** The private project directory: `.catalystrc` and the copy of the relay that gets deployed. */
  private get projectDir(): string {
    return path.join(this.supportDir, "catalyst-relay");
  }

  // ---- config ----

  config(): CatalystConfig {
    const block = this.readCloud()["catalyst"];
    const b = (block && typeof block === "object" ? block : {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return {
      projectId: str(b["projectId"]),
      projectName: str(b["projectName"]),
      dc: str(b["dc"]) ?? "in",
      appUrl: str(b["appUrl"]),
      relayKey: str(b["relayKey"]),
      deployedVersion: str(b["deployedVersion"]),
    };
  }

  setConfig(patch: Partial<CatalystConfig>): void {
    const all = this.readCloud();
    const next = { ...this.config(), ...patch };
    all["catalyst"] = next;
    const file = this.cloudFile;
    const tmp = `${file}.${process.pid}.${this.now()}.tmp`;
    // Synchronous on purpose: config() is synchronous and callers read it straight after.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  private readCloud(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.cloudFile, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  // ---- the CLI ----

  async cliStatus(): Promise<{ installed: boolean; version?: string; loggedIn: boolean; org?: string }> {
    const v = await this.run("catalyst", ["--version"], { timeoutMs: CLI_TIMEOUT_MS });
    const version = stripAnsi(`${v.stdout}\n${v.stderr}`).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if (v.code !== 0 || !version) return { installed: false, loggedIn: false };
    const w = await this.run("catalyst", ["whoami"], { timeoutMs: CLI_TIMEOUT_MS });
    const who = stripAnsi(`${w.stdout}\n${w.stderr}`).match(/Logged as:\s*(.+)/i)?.[1];
    if (w.code !== 0 || !who) return { installed: true, version, loggedIn: false };
    const org = who.replace(/\s+undefined\s*$/, "").trim();
    return { installed: true, version, loggedIn: true, ...(org ? { org } : {}) };
  }

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    // `catalyst project:list` is an interactive org menu outside a project; `init -ni` without -p fails on
    // purpose and prints the projects as `* name(id)` (the CLI calls them orgs). Nothing is written.
    const dir = await this.scratchDir();
    try {
      const r = await this.run("catalyst", ["init", "-ni"], { cwd: dir, timeoutMs: CLI_TIMEOUT_MS });
      const projects: Array<{ id: string; name: string }> = [];
      for (const line of stripAnsi(`${r.stdout}\n${r.stderr}`).split("\n")) {
        const m = line.match(/^\s*\*\s*(.+?)\s*\((\d{6,})\)\s*$/);
        if (m && m[1] && m[2]) projects.push({ id: m[2], name: m[1] });
      }
      return projects;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async selectProject(projectId: string): Promise<CatalystConfig> {
    if (!/^\d{6,30}$/.test(projectId)) throw new CatalystSetupError("That is not a Catalyst project id.");
    const config = this.config();
    if (!TLD[config.dc]) throw new CatalystSetupError("That Catalyst data centre is not supported.");
    await mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    await rm(path.join(this.projectDir, ".catalystrc"), { force: true });
    const r = await this.run("catalyst", ["init", "-p", projectId, "-ni"], {
      cwd: this.projectDir,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const rc = await this.readRc(projectId);
    if (r.code !== 0 || !rc)
      throw new CatalystSetupError("Could not select that project. Check you are signed in to Catalyst.");
    const appUrl = rc.domain ? `https://${rc.domain}.catalystserverless.${TLD[config.dc]}` : null;
    this.setConfig({
      projectId,
      projectName: rc.name,
      appUrl,
      // A different project has none of the old deploy.
      ...(config.projectId === projectId ? {} : { deployedVersion: null }),
    });
    return this.config();
  }

  private async readRc(projectId: string): Promise<{ name: string; domain: string | null } | null> {
    try {
      const rc = JSON.parse(await readFile(path.join(this.projectDir, ".catalystrc"), "utf8")) as {
        projects?: Array<{ id?: unknown; name?: unknown; domain?: { name?: unknown } }>;
      };
      const p = rc.projects?.find((x) => String(x.id) === projectId);
      if (!p || typeof p.name !== "string") return null;
      const domain =
        typeof p.domain?.name === "string" && /^[A-Za-z0-9.-]+$/.test(p.domain.name) ? p.domain.name : null;
      return { name: p.name, domain };
    } catch {
      return null;
    }
  }

  async deploy(): Promise<CatalystConfig> {
    const config = this.config();
    if (!config.projectId) throw new CatalystSetupError("Pick a Catalyst project first.");
    if (this.deploying) throw new CatalystSetupError("A deploy is already running.");
    this.deploying = true;
    try {
      const relayKey = config.relayKey ?? randomBytes(32).toString("base64url");
      // Saved before the deploy: a deploy that half-worked must not strand a key the function already holds.
      if (!config.relayKey) this.setConfig({ relayKey });

      const source = relaySourceDir();
      if (!existsSync(path.join(source, "catalyst.json"))) throw new CatalystSetupError("The relay source is missing.");
      await mkdir(this.projectDir, { recursive: true, mode: 0o700 });
      await rm(path.join(this.projectDir, "functions"), { recursive: true, force: true });
      await cp(source, this.projectDir, {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|test)([\\/]|$)/.test(src) && !src.endsWith(".test.ts"),
      });
      const fnDir = path.join(this.projectDir, "functions", FUNCTION);
      const configPath = path.join(fnDir, "catalyst-config.json");
      const fnConfig = JSON.parse(await readFile(configPath, "utf8")) as {
        deployment: { env_variables?: Record<string, string> };
      };
      fnConfig.deployment.env_variables = { ...fnConfig.deployment.env_variables, RELAY_KEY: relayKey };
      await writeFile(configPath, `${JSON.stringify(fnConfig, null, 2)}\n`, { mode: 0o600 });
      const version = String(
        (JSON.parse(await readFile(path.join(fnDir, "package.json"), "utf8")) as { version?: unknown }).version ?? "",
      );

      const install = await this.run(
        "npm",
        [existsSync(path.join(fnDir, "package-lock.json")) ? "ci" : "install", "--omit=dev", "--no-audit", "--no-fund"],
        {
          cwd: fnDir,
          timeoutMs: DEPLOY_TIMEOUT_MS,
        },
      );
      if (install.code !== 0) throw new CatalystSetupError("Could not install the relay's dependencies.");
      const r = await this.run("catalyst", ["deploy", "--only", `functions:${FUNCTION}`, "-ni"], {
        cwd: this.projectDir,
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      if (r.code !== 0)
        throw new CatalystSetupError("The relay deploy failed. Check you are signed in and the project is selected.");
      this.setConfig({ deployedVersion: version || null });
      return this.config();
    } finally {
      this.deploying = false;
    }
  }

  // ---- the relay ----

  async ping(): Promise<{
    ok: boolean;
    store: "ready" | "missing";
    channel: "ready" | "missing";
    version?: string;
  } | null> {
    const { appUrl, relayKey } = this.config();
    if (!appUrl || !relayKey || !validAppUrl(appUrl)) return null;
    try {
      const res = await this.fetchImpl(`${appUrl.replace(/\/+$/, "")}/server/${FUNCTION}/ping`, {
        headers: { "x-squeak-relay": relayKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { ok?: unknown; store?: unknown; channel?: unknown; version?: unknown };
      if (j.ok !== true) return null;
      return {
        ok: true,
        store: j.store === "ready" ? "ready" : "missing",
        channel: j.channel === "ready" ? "ready" : "missing",
        ...(typeof j.version === "string" ? { version: j.version } : {}),
      };
    } catch {
      return null;
    }
  }

  async steps(): Promise<Step[]> {
    const config = this.config();
    const console_ = `https://console.catalyst.zoho.${TLD[config.dc] ?? "in"}/`;
    const cli = await this.cliStatus();
    const cliDone = cli.installed && cli.loggedIn;
    const steps: Step[] = [];

    steps.push(
      cliDone
        ? { id: "cli", state: "done" }
        : {
            id: "cli",
            state: "todo",
            detail: cli.installed
              ? "Sign in with catalyst login."
              : "Install the Catalyst CLI with npm i -g zcatalyst-cli, then sign in with catalyst login.",
          },
    );

    if (!config.projectId) {
      steps.push({
        id: "project",
        state: "todo",
        detail: "Create a project in the Catalyst console, then pick it here.",
        consoleUrl: console_,
      });
    } else if (!config.appUrl) {
      steps.push({
        id: "project",
        state: "error",
        detail: "Paste the project's development domain from Settings, Domains.",
        consoleUrl: console_,
      });
    } else {
      steps.push({ id: "project", state: "done" });
    }

    const ping = config.deployedVersion ? await this.ping() : null;
    const wanted = await this.wantedVersion();

    steps.push(
      ping?.store === "ready"
        ? { id: "table", state: "done" }
        : {
            id: "table",
            state: "todo",
            detail: ping
              ? "Create the NoSQL table squeak_docs, partition key pk (String), sort key doc (String)."
              : "Create the NoSQL table squeak_docs, partition key pk (String), sort key doc (String). It is checked after the deploy.",
            consoleUrl: console_,
          },
    );

    if (this.deploying) {
      steps.push({ id: "deploy", state: "working", detail: "Deploying the relay." });
    } else if (ping && (!wanted || ping.version === wanted)) {
      steps.push({ id: "deploy", state: "done" });
    } else if (ping) {
      steps.push({ id: "deploy", state: "todo", detail: "The deployed relay is out of date. Deploy it again." });
    } else if (config.deployedVersion) {
      steps.push({ id: "deploy", state: "error", detail: "The relay does not answer. Deploy it again." });
    } else {
      steps.push({
        id: "deploy",
        state: "todo",
        detail:
          cliDone && config.projectId ? "Deploy the relay." : "Sign in and pick a project, then deploy the relay.",
      });
    }

    steps.push(
      ping?.channel === "ready"
        ? { id: "channel", state: "done" }
        : {
            id: "channel",
            state: "todo",
            detail:
              "Create the Data Streams channel squeak_notice with access control Custom Logic, and pick the function squeak_relay.",
            consoleUrl: console_,
          },
    );

    steps.push({ id: "verify", state: "todo", detail: "Run the connection test." });
    return steps;
  }

  /** The version of the relay this build would deploy. */
  private async wantedVersion(): Promise<string | null> {
    try {
      const p = JSON.parse(
        await readFile(path.join(relaySourceDir(), "functions", FUNCTION, "package.json"), "utf8"),
      ) as { version?: unknown };
      return typeof p.version === "string" ? p.version : null;
    } catch {
      return null;
    }
  }

  private async scratchDir(): Promise<string> {
    const dir = path.join(this.supportDir, `catalyst-scratch-${this.now()}-${process.pid}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}

/** The same host rule the phone applies to a relay URL: https under a Catalyst serverless or AppSail domain. */
function validAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      /\.(catalystserverless|catalystappsail)\.(com|in|eu|com\.au|jp|ca|sa)$/.test(u.hostname)
    );
  } catch {
    return false;
  }
}
