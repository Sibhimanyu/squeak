/**
 * STUB. The real `CatalystSetup` (CLI, project, deploy, ping, steps) is built in parallel; the lead replaces
 * this file at merge. Only the API below is relied on elsewhere. The config methods are real: they keep the
 * `catalyst` section of cloud.json.
 */

import { EMPTY_CATALYST, readCloudConfig, writeCloudConfig, type CatalystConfig } from "./config.js";

export type { CatalystConfig } from "./config.js";

export interface Step {
  id: "cli" | "project" | "table" | "deploy" | "channel" | "verify";
  state: "done" | "todo" | "working" | "error";
  detail?: string;
  consoleUrl?: string;
}

export interface CatalystSetupDeps {
  supportDir: string;
  run?: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export class CatalystSetup {
  constructor(private readonly deps: CatalystSetupDeps) {}

  async cliStatus(): Promise<{ installed: boolean; version?: string; loggedIn: boolean; org?: string }> {
    return { installed: false, loggedIn: false };
  }

  async listProjects(): Promise<{ id: string; name: string }[]> {
    return [];
  }

  async selectProject(id: string): Promise<CatalystConfig> {
    void id;
    throw new Error("not implemented");
  }

  async deploy(): Promise<CatalystConfig> {
    throw new Error("not implemented");
  }

  async ping(): Promise<{
    ok: boolean;
    store: "ready" | "missing";
    channel: "ready" | "missing";
    version?: string;
  } | null> {
    return null;
  }

  async steps(): Promise<Step[]> {
    return (["cli", "project", "table", "deploy", "channel", "verify"] as const).map((id) => ({
      id,
      state: "todo" as const,
    }));
  }

  config(): CatalystConfig {
    return readCloudConfig(this.deps.supportDir)?.catalyst ?? { ...EMPTY_CATALYST };
  }

  setConfig(patch: Partial<CatalystConfig>): void {
    const file = readCloudConfig(this.deps.supportDir) ?? { active: "firebase" as const };
    writeCloudConfig(this.deps.supportDir, { ...file, catalyst: { ...(file.catalyst ?? EMPTY_CATALYST), ...patch } });
  }
}
