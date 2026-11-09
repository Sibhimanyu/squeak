import fs from "node:fs";
import path from "node:path";

import { LogBuffer, runScript } from "../native/scripts.js";
import { assertInside } from "./paths.js";
import type { SetupCommand, SetupResult, WorkspaceMetadata } from "./types.js";

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

export const looksSecret = (key: string): boolean => SECRET_KEY.test(key);

/** Splits an environment into what may be written to disk and the names of what may not. */
export function splitEnvironment(env: Record<string, string>): { plain: Record<string, string>; secretRefs: string[] } {
  const plain: Record<string, string> = {};
  const secretRefs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (looksSecret(k)) secretRefs.push(k);
    else plain[k] = v;
  }
  return { plain, secretRefs };
}

export function makeRedactor(secrets: Iterable<string>): (text: string) => string {
  const values = [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => values.reduce((t, v) => t.split(v).join("[redacted]"), text);
}

export function normalizeSetup(commands: (string | SetupCommand)[] | undefined): SetupCommand[] {
  return (commands ?? []).map((c) => (typeof c === "string" ? { command: c } : { ...c }));
}

/** Squeak's variable names plus Conductor's aliases, so scripts written for either run unchanged. */
export function workspaceEnv(
  ws: Pick<WorkspaceMetadata, "path" | "name" | "repositoryRoot" | "branch" | "portBase">,
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const root = ws.repositoryRoot ?? ws.path;
  const own: Record<string, string> = {
    SQUEAK_ROOT_PATH: root,
    SQUEAK_WORKSPACE_PATH: ws.path,
    SQUEAK_WORKSPACE_NAME: ws.name,
    CONDUCTOR_ROOT_PATH: root,
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
  };
  if (ws.branch) own.SQUEAK_BRANCH = ws.branch;
  if (ws.portBase) {
    own.SQUEAK_PORT = String(ws.portBase);
    own.CONDUCTOR_PORT = String(ws.portBase);
  }
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) merged[k] = v;
  return { ...merged, ...own, ...extra };
}

class FileLog extends LogBuffer {
  constructor(
    private readonly file: string,
    private readonly redact: (t: string) => string,
  ) {
    super();
  }
  override append(chunk: string): void {
    const safe = this.redact(chunk);
    super.append(safe);
    try {
      fs.appendFileSync(this.file, safe);
    } catch {
      // logging must not fail setup
    }
  }
}

export interface SetupRun {
  results: SetupResult[];
  ok: boolean;
}

export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000;

/** Runs setup commands in order in the workspace. Stops at the first failure unless it says continueOnFailure. */
export async function runSetupCommands(input: {
  workspacePath: string;
  commands: SetupCommand[];
  env: Record<string, string>;
  logDir: string;
  redact: (t: string) => string;
}): Promise<SetupRun> {
  fs.mkdirSync(input.logDir, { recursive: true });
  const results: SetupResult[] = [];
  let ok = true;
  for (const [i, cmd] of input.commands.entries()) {
    const logPath = path.join(input.logDir, `setup-${i + 1}.log`);
    const started = Date.now();
    let cwd = input.workspacePath;
    if (cmd.workingDirectory)
      cwd = assertInside(input.workspacePath, path.resolve(input.workspacePath, cmd.workingDirectory));
    fs.writeFileSync(logPath, `$ ${input.redact(cmd.command)}\n`);
    const log = new FileLog(logPath, input.redact);
    const run = runScript({
      script: cmd.command,
      cwd,
      env: input.env,
      log,
      timeoutMs: cmd.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
    });
    const r = await run.done;
    const failed = r.timedOut || r.code !== 0;
    fs.appendFileSync(
      logPath,
      `\n[exit ${r.timedOut ? "timeout" : String(r.code ?? r.signal)} after ${Date.now() - started} ms]\n`,
    );
    results.push({
      command: input.redact(cmd.command),
      exitCode: r.code,
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      logPath,
    });
    if (failed && !cmd.continueOnFailure) {
      ok = false;
      break;
    }
  }
  return { results, ok };
}
