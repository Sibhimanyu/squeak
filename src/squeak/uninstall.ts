import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  removeAskFormatBlock,
  removeAskFormatHook,
  defaultAskFormatPaths,
  uninstallAskFormat,
} from "../fleet/ask-format.js";
import {
  defaultHookInstallPaths,
  readJsonObject,
  removeHookConfig,
  uninstallFleetHooks,
} from "../fleet/hook-install.js";
import {
  ENABLE_KEY,
  OVERRIDE_KEY,
  realEffects,
  resetRelay,
  type RelayEffects,
} from "../fleet/conductor-relay/setup.js";
import { HOTSPOT_KEYCHAIN_SERVICE } from "../fleet/hotspot.js";
import { defaultSqueakSupportDir } from "./paths.js";

/**
 * `squeak uninstall`: the one implementation of removing Squeak from a Mac, run by the terminal and by
 * Squeak for Mac. Contract: `.context/uninstall-contract.md`. It runs in its own process (never the
 * daemon, which it stops), and every outside effect goes through `UninstallSystem` so a test runs in a
 * temp HOME with no launchd, Keychain, sudo, admin prompt or real Conductor.
 *
 * Nothing here prints a token, key or Keychain value: notes are fixed sentences, items are paths and names.
 */

export type StepId = "conductor" | "stop" | "system" | "hooks" | "admin" | "keychain" | "files" | "app";
export type StepStatus = "start" | "done" | "skipped" | "failed";

export interface PlanStep {
  id: StepId;
  title: string;
  detail: string;
  needsAdmin: boolean;
  items: string[];
}

export interface OffMacItem {
  title: string;
  detail: string;
  url?: string;
}

export type UninstallEvent =
  | { event: "plan"; dryRun: boolean; keepData: boolean; steps: PlanStep[] }
  | { event: "step"; id: StepId; status: StepStatus; note: string }
  | { event: "done"; ok: boolean; restartConductor: boolean; appToTrash: string | null; offMac: OffMacItem[] };

export interface KeychainItem {
  /** What the plan calls it. */
  label: string;
  service: string;
  account?: string;
}

export type AdminResult = { ok: true } | { ok: false; cancelled: boolean };

export interface UninstallSystem {
  home: string;
  /** Squeak's support folder (`~/Library/Application Support/squeak`, or where SQUEAK_ENV_PATH points). */
  supportDir: string;
  env: NodeJS.ProcessEnv;
  /** Conductor's database and Keychain, through the relay's own effects. */
  relay(): RelayEffects;
  /** Loaded `com.squeak.*` launchd labels in the user's domain. */
  loadedLaunchLabels(): Promise<string[]>;
  bootout(label: string): Promise<boolean>;
  handsRunning(): Promise<boolean>;
  quitHands(): Promise<boolean>;
  /** Runs the awake backstop script once. */
  runBackstop(scriptPath: string): Promise<boolean>;
  /** `sudo -n pmset -a powermode 0`. */
  energyModeAutomatic(): Promise<boolean>;
  /** The fans helper through its sudoers rule: `auto`. */
  fansAuto(helperPath: string): Promise<boolean>;
  /** The only files the admin step may remove, exact absolute paths. */
  adminPaths: string[];
  /** The root-owned fans helper (one of `adminPaths`). */
  fansHelper: string;
  /** One macOS admin prompt that removes exactly `paths`. */
  adminRemove(paths: string[]): Promise<AdminResult>;
  keychainExists(item: KeychainItem): Promise<boolean>;
  keychainDelete(item: KeychainItem): Promise<boolean>;
  /** Where Squeak.app may be. */
  appCandidates: string[];
}

export interface UninstallOptions {
  dryRun?: boolean;
  keepData?: boolean;
}

export interface UninstallResult {
  ok: boolean;
  restartConductor: boolean;
  appToTrash: string | null;
  offMac: OffMacItem[];
  /** Per step: what it actually acted on (equals the plan's items for every step that ran and succeeded). */
  acted: Partial<Record<StepId, string[]>>;
  statuses: Partial<Record<StepId, StepStatus>>;
}

const APP_SUPPORT_FOLDERS = ["squeak", "Squeak Mac", "SqueakMac"];
const SQUEAK_PREFIX = "com.squeak.";
const HANDS_PROCESS_PATTERN = "Squeak Hands.app/Contents/MacOS";
const SQUEAK_SETTINGS_MARK = "http://127.0.0.1:";

export const KEYCHAIN_ITEMS: KeychainItem[] = [
  { label: `Keychain item "${HOTSPOT_KEYCHAIN_SERVICE}"`, service: HOTSPOT_KEYCHAIN_SERVICE },
  { label: 'Keychain item "com.squeak.mac" (account squeak)', service: "com.squeak.mac", account: "squeak" },
];

export const ADMIN_PATHS = [
  "/etc/sudoers.d/squeak",
  "/etc/sudoers.d/squeak-fans",
  "/etc/sudoers.d/squeak-power",
  "/Library/PrivilegedHelperTools/com.squeak.fans",
];

interface StepResult {
  status: "done" | "skipped" | "failed";
  note: string;
  acted?: string[];
}

interface Step extends PlanStep {
  run(): Promise<StepResult>;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// 1. conductor

interface ConductorFacts {
  items: string[];
  /** Whether Conductor's settings rows are Squeak's to put back (so the user must restart Conductor). */
  rowsChanged: boolean;
}

function conductorFacts(sys: UninstallSystem): ConductorFacts {
  const none: ConductorFacts = { items: [], rowsChanged: false };
  const effects = sys.relay();
  if (effects.findApp() === null || !effects.dbExists()) return none;
  const state = effects.readState();
  const handle = effects.openSettings(true);
  let override: string | undefined;
  try {
    override = handle.get(OVERRIDE_KEY);
  } finally {
    handle.close();
  }
  const squeaksOverride = override?.startsWith(SQUEAK_SETTINGS_MARK) === true;
  const rowsChanged = squeaksOverride || state?.previous != null;
  const createdDevice = Boolean(state?.createdDeviceId);
  if (!rowsChanged && !createdDevice) return none;
  const items: string[] = [];
  if (rowsChanged) {
    items.push(`Conductor setting ${OVERRIDE_KEY} (put back to what it was)`);
    items.push(`Conductor setting ${ENABLE_KEY} (put back to what it was)`);
  }
  if (createdDevice) items.push("Squeak's entry in Conductor's paired-devices Keychain item");
  return { items, rowsChanged };
}

function conductorStep(sys: UninstallSystem, state: { restartConductor: boolean }): Step {
  let facts: ConductorFacts = { items: [], rowsChanged: false };
  let readFailed = false;
  try {
    facts = conductorFacts(sys);
  } catch {
    readFailed = true;
  }
  return {
    id: "conductor",
    title: "Hand Conductor back",
    detail:
      "Puts Conductor's relay settings back to what they were (after backing up its database) and removes the one Keychain entry Squeak added. Done first so Conductor never points at a stopped Squeak.",
    needsAdmin: false,
    items: facts.items,
    async run() {
      if (readFailed) return { status: "failed", note: "Conductor's settings could not be read." };
      if (facts.items.length === 0) return { status: "skipped", note: "Conductor was never set up with Squeak." };
      const effects = sys.relay();
      try {
        // The relay reset reads the live status first; it needs the (read-only) settings once more.
        effects.backupDb(effects.now());
      } catch {
        return { status: "failed", note: "Conductor's database could not be backed up." };
      }
      let outcome;
      try {
        outcome = resetRelay({ effects });
      } catch {
        return { status: "failed", note: "Conductor's settings could not be reset." };
      }
      if (!outcome.ok) return { status: "failed", note: "Conductor's settings could not be reset." };
      const left = effects.readState();
      if (left?.createdDeviceId) {
        return { status: "failed", note: "Squeak's Conductor Keychain entry could not be removed." };
      }
      state.restartConductor = facts.rowsChanged;
      return { status: "done", note: "Conductor is back on its own servers.", acted: facts.items };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 2. stop

async function stopStep(sys: UninstallSystem): Promise<Step> {
  const labels = (await sys.loadedLaunchLabels().catch(() => [] as string[])).filter((l) =>
    l.startsWith(SQUEAK_PREFIX),
  );
  const hands = await sys.handsRunning().catch(() => false);
  const items = [...labels.map((l) => `Launch agent ${l}`), ...(hands ? ["Squeak Hands"] : [])];
  return {
    id: "stop",
    title: "Stop Squeak",
    detail: "Stops the background service and its launch agents, and quits Squeak Hands. Squeak for Mac stays open.",
    needsAdmin: false,
    items,
    async run() {
      if (items.length === 0) return { status: "skipped", note: "Nothing of Squeak was running." };
      const failed: string[] = [];
      for (const label of labels) if (!(await sys.bootout(label))) failed.push(label);
      if (hands) await sys.quitHands();
      if (failed.length > 0) return { status: "failed", note: "A launch agent could not be stopped." };
      return { status: "done", note: "Squeak is stopped.", acted: items };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 3. system

function readPick(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { choice?: unknown };
    return typeof parsed.choice === "string" ? parsed.choice : null;
  } catch {
    return null;
  }
}

function systemStep(sys: UninstallSystem): Step {
  const backstop = path.join(sys.supportDir, "awake-backstop.sh");
  const journals = ["lid-journal.json", "lid-actions.json", "heat-journal.json"].map((n) =>
    path.join(sys.supportDir, n),
  );
  const powerFile = path.join(sys.supportDir, "power-mode.json");
  const pick = readPick(powerFile);
  const items: string[] = [];
  const undoJournals = exists(backstop) && journals.some(exists);
  const undoPower = pick !== null && pick !== "auto";
  const undoFans = exists(sys.fansHelper);
  if (undoJournals) items.push("Awake-session leftovers (sleep, Low Power Mode, paused apps, fans)");
  if (undoPower) items.push("Energy mode back to Automatic");
  if (undoFans) items.push("Fans back to automatic");
  return {
    id: "system",
    title: "Undo system changes",
    detail:
      "Runs the awake backstop once, sets the Energy mode back to Automatic and the fans to automatic, while Squeak's permission rules still exist. Each part is best effort.",
    needsAdmin: false,
    items,
    async run() {
      if (items.length === 0) return { status: "skipped", note: "Squeak left nothing changed on this Mac." };
      const notes: string[] = [];
      if (undoJournals) {
        notes.push((await sys.runBackstop(backstop).catch(() => false)) ? "leftovers undone" : "leftovers not undone");
      }
      if (undoPower) {
        const ok = await sys.energyModeAutomatic().catch(() => false);
        if (ok) {
          try {
            fs.writeFileSync(powerFile, JSON.stringify({ choice: "auto" }) + "\n", { mode: 0o600 });
          } catch {
            // The pick is only a record; the mode itself is back.
          }
        }
        notes.push(ok ? "energy mode automatic" : "energy mode not changed");
      }
      if (undoFans) {
        notes.push((await sys.fansAuto(sys.fansHelper).catch(() => false)) ? "fans automatic" : "fans not changed");
      }
      return { status: "done", note: `Best effort: ${notes.join(", ")}.`, acted: items };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 4. hooks

function hooksStep(sys: UninstallSystem): Step {
  const hookPaths = defaultHookInstallPaths(sys.supportDir, sys.home);
  const askPaths = defaultAskFormatPaths(sys.supportDir, sys.home, sys.env);
  const items = new Set<string>();
  const dirty = (file: string, test: (value: Record<string, unknown>) => boolean) => {
    if (exists(file) && test(readJsonObject(file))) items.add(file);
  };
  dirty(hookPaths.claudeSettingsPath, (v) => removeHookConfig(v).changed);
  dirty(hookPaths.codexHooksPath, (v) => removeHookConfig(v).changed);
  dirty(askPaths.claudeSettingsPath, (v) => removeAskFormatHook(v).changed);
  if (exists(askPaths.codexAgentsPath)) {
    try {
      const text = fs.readFileSync(askPaths.codexAgentsPath, "utf8");
      if (removeAskFormatBlock(text) !== text) items.add(askPaths.codexAgentsPath);
    } catch {
      // Unreadable: nothing of ours can be proven there.
    }
  }
  for (const script of [hookPaths.scriptPath, askPaths.scriptPath]) if (exists(script)) items.add(script);
  const list = [...items];
  return {
    id: "hooks",
    title: "Remove agent hooks",
    detail:
      "Takes Squeak's own hook entries out of Claude Code's and Codex's settings and the ask-format note out of Codex's AGENTS.md (a backup is kept beside each file). Other tools' entries are left alone.",
    needsAdmin: false,
    items: list,
    async run() {
      if (list.length === 0) return { status: "skipped", note: "No Squeak hooks were installed." };
      uninstallFleetHooks(hookPaths);
      uninstallAskFormat(askPaths);
      return { status: "done", note: "Squeak's hooks are removed.", acted: list };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 5. admin

function adminStep(sys: UninstallSystem): Step {
  const items = sys.adminPaths.filter(exists);
  return {
    id: "admin",
    title: "Remove administrator rules",
    detail:
      "One macOS administrator prompt removes Squeak's sudoers rules and the root-owned fans helper (exactly those paths).",
    needsAdmin: true,
    items,
    async run() {
      if (items.length === 0) return { status: "skipped", note: "No administrator rules were installed." };
      const result = await sys.adminRemove(items).catch(() => ({ ok: false, cancelled: false }) as AdminResult);
      if (result.ok) return { status: "done", note: "Administrator rules are removed.", acted: items };
      return {
        status: "failed",
        note: result.cancelled
          ? "Administrator permission was cancelled."
          : "The administrator rules could not be removed.",
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 6. keychain

async function keychainStep(sys: UninstallSystem): Promise<Step> {
  const present: KeychainItem[] = [];
  for (const item of KEYCHAIN_ITEMS) if (await sys.keychainExists(item).catch(() => false)) present.push(item);
  const items = present.map((i) => i.label);
  return {
    id: "keychain",
    title: "Delete Keychain items",
    detail: "Deletes the Keychain items Squeak created. Conductor's and every other app's items are not touched.",
    needsAdmin: false,
    items,
    async run() {
      if (present.length === 0) return { status: "skipped", note: "Squeak had no Keychain items." };
      let failed = false;
      for (const item of present) if (!(await sys.keychainDelete(item).catch(() => false))) failed = true;
      if (failed) return { status: "failed", note: "A Keychain item could not be deleted." };
      return { status: "done", note: "Squeak's Keychain items are deleted.", acted: items };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 7. files

function listMatching(dir: string, test: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(test)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Every path the files step may touch, as it stands now. Nothing outside this list is ever removed. */
export function filesToRemove(home: string, keepData: boolean): string[] {
  const lib = path.join(home, "Library");
  const ours = (name: string) => name.startsWith(SQUEAK_PREFIX);
  const found = [
    ...listMatching(path.join(lib, "LaunchAgents"), (n) => ours(n) && n.endsWith(".plist")),
    path.join(lib, "Logs", "squeak"),
    ...listMatching(path.join(lib, "Caches"), ours),
    ...listMatching(path.join(lib, "Preferences"), (n) => ours(n) && n.endsWith(".plist")),
    ...listMatching(path.join(lib, "Saved Application State"), ours),
    ...(keepData ? [] : APP_SUPPORT_FOLDERS.map((n) => path.join(lib, "Application Support", n))),
  ];
  return found.filter(exists);
}

/** Removes one listed path. A symlink is unlinked itself, never followed; the parent must resolve inside HOME. */
function removeListed(entry: string, home: string): boolean {
  try {
    const realHome = fs.realpathSync(home);
    const realParent = fs.realpathSync(path.dirname(entry));
    if (realParent !== realHome && !realParent.startsWith(realHome + path.sep)) return false;
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(entry);
    else fs.rmSync(entry, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function filesStep(sys: UninstallSystem, keepData: boolean): Step {
  const items = filesToRemove(sys.home, keepData);
  return {
    id: "files",
    title: "Delete Squeak's files",
    detail: keepData
      ? "Deletes launch agents, logs, caches and preferences. Your Squeak settings and data are kept."
      : "Deletes launch agents, logs, caches, preferences and Squeak's settings and data folders.",
    needsAdmin: false,
    items,
    async run() {
      if (items.length === 0) return { status: "skipped", note: "Squeak had no files left." };
      const failed = items.filter((entry) => !removeListed(entry, sys.home));
      if (failed.length > 0) return { status: "failed", note: "Some of Squeak's files could not be deleted." };
      return { status: "done", note: "Squeak's files are deleted.", acted: items };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 8. app

function appPath(sys: UninstallSystem): string | null {
  return sys.appCandidates.find((p) => exists(p)) ?? null;
}

function appStep(sys: UninstallSystem): Step {
  const found = appPath(sys);
  return {
    id: "app",
    title: "Squeak.app (moved to the Trash by the Mac app)",
    detail: "The app is not removed here: Squeak for Mac moves itself to the Trash after it quits.",
    needsAdmin: false,
    items: found ? [found] : [],
    async run() {
      return found
        ? { status: "done", note: "Squeak.app is left for the Mac app to move to the Trash.", acted: [found] }
        : { status: "skipped", note: "Squeak.app was not found." };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Off-Mac checklist

function firebaseProject(sys: UninstallSystem): string | null {
  const valid = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{4,29}$/.test(v);
  const fromEnv = sys.env.SQUEAK_REMOTE_PROJECT?.trim();
  if (valid(fromEnv)) return fromEnv;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sys.supportDir, "remote.json"), "utf8")) as {
      projectId?: unknown;
    };
    return valid(parsed.projectId) ? parsed.projectId : null;
  } catch {
    return null;
  }
}

export function offMacChecklist(project: string | null): OffMacItem[] {
  return [
    {
      title: "iPhone app",
      detail: "Delete Squeak from your iPhone; that also unpairs it.",
    },
    {
      title: 'Home Assistant add-on "Squeak Voice"',
      detail: "Remove the add-on in Home Assistant if you installed it.",
    },
    {
      title: "Firebase project",
      detail: `${project ? `Project ${project}: ` : ""}delete the project or leave it; it holds only sealed data.`,
      url: "https://console.firebase.google.com",
    },
    {
      title: "Telegram bot",
      detail: "If you made a bot for Squeak, delete it with @BotFather.",
      url: "https://t.me/BotFather",
    },
    { title: "Zoho Cliq bot", detail: "Remove the Squeak bot in Zoho Cliq if you created one." },
  ];
}

// ---------------------------------------------------------------------------------------------
// The run

async function buildSteps(
  sys: UninstallSystem,
  options: UninstallOptions,
  flags: { restartConductor: boolean },
): Promise<Step[]> {
  return [
    conductorStep(sys, flags),
    await stopStep(sys),
    systemStep(sys),
    hooksStep(sys),
    adminStep(sys),
    await keychainStep(sys),
    filesStep(sys, options.keepData === true),
    appStep(sys),
  ];
}

const toPlan = (s: Step): PlanStep => ({
  id: s.id,
  title: s.title,
  detail: s.detail,
  needsAdmin: s.needsAdmin,
  items: s.items,
});

export async function planUninstall(sys: UninstallSystem, options: UninstallOptions = {}): Promise<PlanStep[]> {
  return (await buildSteps(sys, options, { restartConductor: false })).map(toPlan);
}

export async function runUninstall(
  sys: UninstallSystem,
  options: UninstallOptions,
  emit: (event: UninstallEvent) => void,
): Promise<UninstallResult> {
  const flags = { restartConductor: false };
  const steps = await buildSteps(sys, options, flags);
  const dryRun = options.dryRun === true;
  const keepData = options.keepData === true;
  emit({ event: "plan", dryRun, keepData, steps: steps.map(toPlan) });

  const appToTrash = appPath(sys);
  const offMac = offMacChecklist(firebaseProject(sys));
  const result: UninstallResult = {
    ok: true,
    restartConductor: false,
    appToTrash,
    offMac,
    acted: {},
    statuses: {},
  };
  if (!dryRun) {
    for (const step of steps) {
      emit({ event: "step", id: step.id, status: "start", note: "" });
      let outcome: StepResult;
      try {
        outcome = await step.run();
      } catch {
        outcome = { status: "failed", note: "This step failed unexpectedly." };
      }
      result.statuses[step.id] = outcome.status;
      if (outcome.acted) result.acted[step.id] = outcome.acted;
      emit({ event: "step", id: step.id, status: outcome.status, note: outcome.note });
      if (outcome.status === "failed") {
        result.ok = false;
        // Conductor goes first and alone is fatal: Squeak's proxy must keep answering it.
        if (step.id === "conductor") break;
      }
    }
    result.restartConductor = flags.restartConductor;
  }
  emit({
    event: "done",
    ok: result.ok,
    restartConductor: result.restartConductor,
    appToTrash,
    offMac,
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// The command

export interface UninstallIO {
  stdout(line: string): void;
  stderr(line: string): void;
  /** True when a person can answer a prompt. */
  isTTY: boolean;
  confirm(question: string): Promise<boolean>;
}

const USAGE = "Usage: squeak uninstall [--dry-run] [--keep-data] [--yes] [--json]";

function humanPlan(steps: PlanStep[]): string[] {
  const lines: string[] = ["Squeak will be removed from this Mac:"];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}${step.needsAdmin ? " (asks for your administrator password)" : ""}`);
    lines.push(`   ${step.detail}`);
    for (const item of step.items) lines.push(`   - ${item}`);
  });
  return lines;
}

/** Exit code: 0 done or skipped, 1 a step failed, 2 bad usage or not confirmed. */
export async function runUninstallCommand(args: string[], io: UninstallIO, sys: UninstallSystem): Promise<number> {
  const known = new Set(["--dry-run", "--keep-data", "--yes", "--json"]);
  const bad = args.filter((a) => !known.has(a));
  if (bad.length > 0) {
    io.stderr(`Unknown option: ${bad[0]}`);
    io.stderr(USAGE);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const keepData = args.includes("--keep-data");
  const json = args.includes("--json");
  const human = json ? io.stderr : io.stdout;

  if (!dryRun && !args.includes("--yes")) {
    if (!io.isTTY) {
      io.stderr("Not confirmed: pass --yes to uninstall without a prompt, or --dry-run to see the plan.");
      return 2;
    }
    for (const line of humanPlan(await planUninstall(sys, { keepData }))) io.stderr(line);
    if (!(await io.confirm("Remove Squeak? [y/N] "))) {
      io.stderr("Nothing was changed.");
      return 2;
    }
  }

  const result = await runUninstall(sys, { dryRun, keepData }, (event) => {
    if (json) {
      io.stdout(JSON.stringify(event));
    } else if (event.event === "plan") {
      for (const line of humanPlan(event.steps)) human(line);
      if (event.dryRun) human("Dry run: nothing was changed.");
    } else if (event.event === "step" && event.status !== "start") {
      human(`${event.id}: ${event.status} - ${event.note}`);
    } else if (event.event === "done") {
      human(event.ok ? "Done." : "Some steps failed; run it again to finish.");
      if (event.restartConductor) human("Restart Conductor once so it goes back to its own servers.");
      if (event.ok && !dryRun) {
        human("Still to do by hand:");
        for (const item of event.offMac) human(`- ${item.title}: ${item.detail}${item.url ? ` ${item.url}` : ""}`);
        if (event.appToTrash) human(`Move ${event.appToTrash} to the Trash.`);
      }
    }
  });
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// The real system

function run(file: string, args: string[], timeout = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    ),
  );
}

export function realUninstallSystem(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  supportDir = defaultSqueakSupportDir(home),
): UninstallSystem {
  const uid = process.getuid?.() ?? os.userInfo().uid;
  const fansHelper = "/Library/PrivilegedHelperTools/com.squeak.fans";
  return {
    home,
    supportDir,
    env,
    relay: () =>
      realEffects({
        conductorDbPath: path.join(home, "Library/Application Support/com.conductor.app/conductor.db"),
        statePath: path.join(supportDir, "conductor-relay.json"),
        appPaths: ["/Applications/Conductor.app", path.join(home, "Applications/Conductor.app")],
      }),
    loadedLaunchLabels: async () => {
      const out = await run("/bin/launchctl", ["list"]);
      return out.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[2] ?? "")
        .filter((label) => label.startsWith(SQUEAK_PREFIX));
    },
    bootout: async (label) => (await run("/bin/launchctl", ["bootout", `gui/${uid}/${label}`])).ok,
    handsRunning: async () => (await run("/usr/bin/pgrep", ["-f", HANDS_PROCESS_PATTERN])).ok,
    quitHands: async () => (await run("/usr/bin/pkill", ["-f", HANDS_PROCESS_PATTERN])).ok,
    runBackstop: async (script) => (await run("/bin/bash", [script], 60_000)).ok,
    energyModeAutomatic: async () => (await run("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "-a", "powermode", "0"])).ok,
    fansAuto: async (helper) => (await run("/usr/bin/sudo", ["-n", helper, "auto"])).ok,
    adminPaths: ADMIN_PATHS,
    fansHelper,
    adminRemove: async (paths) => {
      const allowed = paths.filter((p) => ADMIN_PATHS.includes(p));
      if (allowed.length === 0) return { ok: true };
      const quoted = allowed.map((p) => `'${p}'`).join(" ");
      const script = `do shell script "/bin/rm -f ${quoted}" with administrator privileges with prompt "Squeak wants to remove its administrator rules."`;
      const out = await run("/usr/bin/osascript", ["-e", script], 300_000);
      if (out.ok) return { ok: true };
      return { ok: false, cancelled: /-128|User canceled/i.test(out.stderr) };
    },
    keychainExists: async (item) =>
      (
        await run("/usr/bin/security", [
          "find-generic-password",
          "-s",
          item.service,
          ...(item.account ? ["-a", item.account] : []),
        ])
      ).ok,
    keychainDelete: async (item) =>
      (
        await run("/usr/bin/security", [
          "delete-generic-password",
          "-s",
          item.service,
          ...(item.account ? ["-a", item.account] : []),
        ])
      ).ok,
    appCandidates: ["/Applications/Squeak.app", path.join(home, "Applications/Squeak.app")],
  };
}

export function terminalIO(): UninstallIO {
  return {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirm: (question) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(question, (answer) => {
          rl.close();
          resolve(/^y(es)?$/i.test(answer.trim()));
        });
      }),
  };
}
