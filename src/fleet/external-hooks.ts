import fs from "node:fs";

import { enabledAddonIds } from "../addon-host.js";
import { defaultHookInstallPaths, type HookAgents } from "./hook-install.js";
import { HooksSetup, type HooksOutcome } from "./hooks-setup.js";

/** The two add-ons that read Claude Code and Codex running outside Squeak (addons/claude-external, addons/codex-external). */
export const CLAUDE_EXTERNAL_ID = "claude-external";
export const CODEX_EXTERNAL_ID = "codex-external";

/** Which agents have hooks wanted, from the enabled add-on ids: hooks exist only for an agent whose add-on is on. */
export function externalHookAgents(enabled: readonly string[]): HookAgents {
  return { claude: enabled.includes(CLAUDE_EXTERNAL_ID), codex: enabled.includes(CODEX_EXTERNAL_ID) };
}

export interface ReconcileOptions {
  supportDir: string;
  port: number;
  /** Enabled add-on ids; absent: read from `addons.json` now (the state the toggle just saved). */
  enabled?: readonly string[];
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Makes the agents' hook files match the add-ons: an enabled add-on installs its agent's hooks (and ask format),
 * a disabled one removes Squeak's entries (backup first, nothing else touched). Idempotent and cheap when nothing
 * differs, so every start reconciles both ways, including a switch flipped while the daemon was down. A settings
 * file that is not valid JSON is left alone. Returns null when nothing needed doing.
 */
export async function reconcileExternalHooks(options: ReconcileOptions): Promise<HooksOutcome | null> {
  const agents = externalHookAgents(options.enabled ?? enabledAddonIds(options.supportDir));
  const setup = new HooksSetup({
    supportDir: options.supportDir,
    port: options.port,
    agents: () => agents,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const wanted = agents.claude || agents.codex;
  const status = setup.status();
  if (status.state === "error") return { ok: false, status, reason: status.message };
  if (wanted ? status.state === "installed" : status.state === "missing" && !markerPresent(options)) return null;
  return wanted ? setup.install() : setup.uninstall();
}

function markerPresent(options: ReconcileOptions): boolean {
  const marker = defaultHookInstallPaths(options.supportDir, options.homeDir).enabledPath;
  return marker ? fs.existsSync(marker) : false;
}
