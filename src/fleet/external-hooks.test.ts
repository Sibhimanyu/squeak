import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_EXTERNAL_ID, CODEX_EXTERNAL_ID, externalHookAgents, reconcileExternalHooks } from "./external-hooks.js";
import { defaultHookInstallPaths, fleetHooksInstalled } from "./hook-install.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-hooks-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const supportDir = path.join(root, "support");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(supportDir, { recursive: true });
  const other = { hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool" }] }] } };
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(other));
  const paths = defaultHookInstallPaths(supportDir, home);
  const run = (enabled: string[]) =>
    reconcileExternalHooks({ supportDir, port: 8477, enabled, homeDir: home, env: {} });
  return { home, supportDir, paths, run, other };
}

const claudeSettings = (home: string) => fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");

describe("hooks follow the external add-ons", () => {
  it("maps enabled ids to agents", () => {
    expect(externalHookAgents([])).toEqual({ claude: false, codex: false });
    expect(externalHookAgents([CLAUDE_EXTERNAL_ID])).toEqual({ claude: true, codex: false });
    expect(externalHookAgents(["conductor", CODEX_EXTERNAL_ID])).toEqual({ claude: false, codex: true });
  });

  it("does nothing while both are off and nothing of ours is there", async () => {
    const { run, paths, home, other } = layout();
    expect(await run([])).toBeNull();
    expect(fleetHooksInstalled(paths)).toBe(false);
    expect(JSON.parse(claudeSettings(home))).toEqual(other);
    expect(fs.existsSync(paths.enabledPath as string)).toBe(false);
  });

  it("enabling Claude installs only Claude's hooks, with a marker and a backup, keeping other tools' entries", async () => {
    const { run, paths, home } = layout();
    const outcome = await run([CLAUDE_EXTERNAL_ID]);
    expect(outcome?.ok).toBe(true);

    const settings = JSON.parse(claudeSettings(home)) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.Stop?.flatMap((group) => group.hooks.map((hook) => hook.command))).toEqual(
      expect.arrayContaining(["/usr/local/bin/other-tool", expect.stringContaining("fleet-notify.sh")]),
    );
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(fs.existsSync(path.join(home, ".claude", "settings.json.squeak.bak"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex", "hooks.json"))).toBe(false);
    expect(fs.existsSync(paths.enabledPath as string)).toBe(true);
    // Idempotent: a second pass finds nothing to do.
    expect(await run([CLAUDE_EXTERNAL_ID])).toBeNull();
  });

  it("disabling removes only Squeak's entries, the script, the marker and the ask format", async () => {
    const { run, paths, home, other, supportDir } = layout();
    await run([CLAUDE_EXTERNAL_ID, CODEX_EXTERNAL_ID]);
    expect(fleetHooksInstalled(paths)).toBe(true);
    expect(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8")).toContain("squeak:ask-format:start");

    const outcome = await run([]);
    expect(outcome?.ok).toBe(true);
    expect(fleetHooksInstalled(paths)).toBe(false);
    expect(JSON.parse(claudeSettings(home))).toEqual(other);
    expect(fs.existsSync(paths.scriptPath)).toBe(false);
    expect(fs.existsSync(paths.enabledPath as string)).toBe(false);
    expect(fs.existsSync(path.join(supportDir, "ask-format.sh"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8")).not.toContain("squeak:ask-format");
  });

  it("turning one add-on off keeps the other's hooks", async () => {
    const { run, home } = layout();
    await run([CLAUDE_EXTERNAL_ID, CODEX_EXTERNAL_ID]);
    await run([CODEX_EXTERNAL_ID]);
    expect(claudeSettings(home)).not.toContain("fleet-notify.sh");
    expect(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")).toContain("fleet-notify.sh");
  });

  it("reconciles at start: a disabled add-on's leftover hooks are removed, an enabled one's missing hooks are put back", async () => {
    const { run, home, paths } = layout();
    await run([CLAUDE_EXTERNAL_ID]);
    // The switch was flipped while the daemon was down (addons.json says off, hooks still there).
    expect((await run([]))?.ok).toBe(true);
    expect(fleetHooksInstalled(paths)).toBe(false);
    // And the other way: on, but the hooks were wiped.
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    expect((await run([CLAUDE_EXTERNAL_ID]))?.ok).toBe(true);
    expect(claudeSettings(home)).toContain("fleet-notify.sh");
  });

  it("leaves a settings file that is not valid JSON alone", async () => {
    const { run, home } = layout();
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ nope");
    const outcome = await run([CLAUDE_EXTERNAL_ID]);
    expect(outcome?.ok).toBe(false);
    expect(claudeSettings(home)).toBe("{ nope");
  });

  it("the script does nothing without the marker (no curl, exit 0) and posts with it", async () => {
    const { run, paths, supportDir } = layout();
    await run([CLAUDE_EXTERNAL_ID]);
    const bin = path.join(supportDir, "bin");
    fs.mkdirSync(bin);
    const trace = path.join(supportDir, "curl-ran");
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho ran >> "${trace}"\n`, { mode: 0o755 });
    fs.writeFileSync(paths.tokenPath, "token");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const call = () => execFileSync("/bin/sh", [paths.scriptPath], { input: "{}", env });

    fs.rmSync(paths.enabledPath as string);
    call();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(trace)).toBe(false);

    fs.writeFileSync(paths.enabledPath as string, "1\n");
    call();
    for (let i = 0; i < 330 && !fs.existsSync(trace); i += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.existsSync(trace)).toBe(true);
  });
});
