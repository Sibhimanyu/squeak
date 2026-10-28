import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HooksSetup } from "./hooks-setup.js";
import { CLAUDE_HOOK_EVENTS } from "./hook-install.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function setup(env: NodeJS.ProcessEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-setup-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const support = path.join(root, "support");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const settings = path.join(home, ".claude", "settings.json");
  const agents = path.join(home, ".codex", "AGENTS.md");
  const hooks = new HooksSetup({ supportDir: support, port: 8477, homeDir: home, env });
  return { root, home, support, settings, agents, hooks };
}

const other = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool --stop" }] }] }, theme: "dark" };

describe("HooksSetup", () => {
  it("reports missing when nothing is installed, without writing anything", () => {
    const t = setup();
    const status = t.hooks.status();
    expect(status.state).toBe("missing");
    expect(status.claude).toEqual({
      settingsFound: false,
      hooksInstalled: false,
      missing: [...CLAUDE_HOOK_EVENTS],
      askFormat: false,
    });
    expect(status.codex).toEqual({ agentsFound: false, askFormat: false });
    expect(fs.existsSync(t.support)).toBe(false);
  });

  it("installs, merges beside other tools, and reports installed", async () => {
    const t = setup();
    fs.writeFileSync(t.settings, JSON.stringify(other));
    const out = await t.hooks.install();
    expect(out.ok).toBe(true);
    expect(out.status.state).toBe("installed");
    expect(out.status.claude.missing).toEqual([]);
    expect(out.status.claude.askFormat && out.status.codex.askFormat).toBe(true);
    const written = JSON.parse(fs.readFileSync(t.settings, "utf8"));
    expect(written.theme).toBe("dark");
    expect(JSON.stringify(written.hooks.Stop)).toContain("other-tool --stop");
    expect(fs.existsSync(`${t.settings}.squeak.bak`)).toBe(true);
  });

  it("is idempotent: a second install changes nothing and makes no second backup", async () => {
    const t = setup();
    fs.writeFileSync(t.settings, JSON.stringify(other));
    await t.hooks.install();
    const content = fs.readFileSync(t.settings, "utf8");
    const agents = fs.readFileSync(t.agents, "utf8");
    fs.writeFileSync(`${t.settings}.squeak.bak`, "FIRST BACKUP");
    const second = await t.hooks.install();
    expect(second.ok).toBe(true);
    expect(fs.readFileSync(t.settings, "utf8")).toBe(content);
    expect(fs.readFileSync(t.agents, "utf8")).toBe(agents);
    expect(fs.readFileSync(`${t.settings}.squeak.bak`, "utf8")).toBe("FIRST BACKUP");
  });

  it("calls a missing event or a stale script path partial, and install repairs it", async () => {
    const t = setup();
    await t.hooks.install();
    const settings = JSON.parse(fs.readFileSync(t.settings, "utf8"));
    delete settings.hooks.Stop;
    settings.hooks.Notification[0].hooks[0].command = "SQUEAK_AGENT=claude /old/place/fleet-notify.sh";
    fs.writeFileSync(t.settings, JSON.stringify(settings));
    const partial = t.hooks.status();
    expect(partial.state).toBe("partial");
    expect(partial.claude.hooksInstalled).toBe(false);
    expect(partial.claude.missing.sort()).toEqual(["Notification", "Stop"]);
    expect(partial.steps.length).toBeGreaterThan(0);
    expect((await t.hooks.install()).status.state).toBe("installed");
  });

  it("is partial when only the ask format is missing, and honours SQUEAK_ASK_FORMAT=off", async () => {
    const t = setup();
    await t.hooks.install();
    fs.rmSync(t.agents);
    expect(t.hooks.status().state).toBe("partial");
    const off = new HooksSetup({
      supportDir: t.support,
      port: 8477,
      homeDir: t.home,
      env: { SQUEAK_ASK_FORMAT: "off" },
    });
    expect(off.status().state).toBe("partial");
    const out = await off.install();
    expect(out.status.state).toBe("installed");
    expect(out.status.claude.askFormat).toBe(false);
    expect(fs.readFileSync(t.settings, "utf8")).not.toContain("ask-format.sh");
  });

  it("reports error and writes nothing when a settings file is not valid JSON", async () => {
    const t = setup();
    fs.writeFileSync(t.settings, "{ not json");
    expect(t.hooks.status().state).toBe("error");
    const out = await t.hooks.install();
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
    expect(fs.readFileSync(t.settings, "utf8")).toBe("{ not json");
    expect((await t.hooks.uninstall()).ok).toBe(false);
  });

  it("uninstall removes only Squeak's entries, block and scripts", async () => {
    const t = setup();
    fs.writeFileSync(t.settings, JSON.stringify(other));
    fs.mkdirSync(path.dirname(t.agents), { recursive: true });
    fs.writeFileSync(t.agents, "# my notes\n");
    await t.hooks.install();
    const out = await t.hooks.uninstall();
    expect(out.ok).toBe(true);
    expect(out.status.state).toBe("missing");
    expect(JSON.parse(fs.readFileSync(t.settings, "utf8"))).toEqual(other);
    expect(fs.readFileSync(t.agents, "utf8")).toContain("# my notes");
    expect(fs.readFileSync(t.agents, "utf8")).not.toContain("squeak:ask-format");
    expect(fs.existsSync(path.join(t.support, "ask-format.sh"))).toBe(false);
    expect(fs.existsSync(path.join(t.support, "hooks", "fleet-notify.sh"))).toBe(false);
  });

  it("never puts a path or the token in any response", async () => {
    const t = setup();
    const out = await t.hooks.install();
    const token = fs.readFileSync(path.join(t.support, "hook-token"), "utf8").trim();
    for (const body of [JSON.stringify(out), JSON.stringify(t.hooks.status())]) {
      expect(body).not.toContain(t.root);
      expect(body).not.toContain(token);
      expect(body).not.toContain("/");
    }
  });
});
