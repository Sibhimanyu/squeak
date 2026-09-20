import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultHookInstallPaths,
  fleetHooksInstalled,
  installFleetHooks,
  mergeHookConfig,
  removeHookConfig,
  renderHookScript,
  uninstallFleetHooks,
} from "./hook-install.js";

const temporaryDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-hooks-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    fs.rmSync(temporaryDirs.pop() as string, { recursive: true, force: true });
  }
});

const ourCommand = { type: "command", command: "CONDUCTOR_TG_AGENT=claude /tmp/hooks/fleet-notify.sh", timeout: 5 };

describe("mergeHookConfig", () => {
  it("adds our hook alongside hooks other tools already installed", () => {
    const existing = {
      model: "opus[1m]",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/some/other/tool/stop-hook" }] }],
      },
    };

    const { config, changed } = mergeHookConfig(existing, ["Stop", "Notification"], ourCommand);

    expect(changed).toBe(true);
    const hooks = config.hooks as Record<string, { hooks: { command: string }[] }[]>;
    // The other tool's entry survives untouched, and ours is appended.
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop?.[0]?.hooks?.[0]?.command).toBe("/some/other/tool/stop-hook");
    expect(hooks.Notification).toHaveLength(1);
    expect(config.model).toBe("opus[1m]");
  });

  it("is idempotent", () => {
    const first = mergeHookConfig({}, ["Stop"], ourCommand);
    const second = mergeHookConfig(first.config, ["Stop"], ourCommand);

    expect(second.changed).toBe(false);
    expect((second.config.hooks as Record<string, unknown[]>).Stop).toHaveLength(1);
  });
});

describe("removeHookConfig", () => {
  it("removes only our entries", () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/some/other/tool/stop-hook" }] }, { hooks: [ourCommand] }],
        Notification: [{ hooks: [ourCommand] }],
      },
    };

    const { config, changed } = removeHookConfig(existing);
    const hooks = config.hooks as Record<string, { hooks: { command: string }[] }[]>;

    expect(changed).toBe(true);
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop?.[0]?.hooks?.[0]?.command).toBe("/some/other/tool/stop-hook");
    // An event left with no hooks at all is dropped rather than left empty.
    expect(hooks.Notification).toBeUndefined();
  });

  it("reports no change when nothing of ours is present", () => {
    const { changed } = removeHookConfig({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/other" }] }] },
    });

    expect(changed).toBe(false);
  });
});

describe("renderHookScript", () => {
  it("cannot stall an agent", () => {
    const script = renderHookScript({ agent: "claude", port: 8477, tokenPath: "/tmp/token" });

    // These three are the whole safety story for installing into somebody's
    // global agent config: bounded, backgrounded, and always successful.
    expect(script).toContain("-m 2");
    expect(script).toMatch(/--data-binary @- >\/dev\/null 2>&1 &/);
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });
});

describe("installFleetHooks", () => {
  it("writes the script, merges both configs, and backs up what it replaces", () => {
    const home = makeHome();
    const supportDir = path.join(home, "support");
    const paths = defaultHookInstallPaths(supportDir, home);

    fs.mkdirSync(path.dirname(paths.claudeSettingsPath), { recursive: true });
    fs.writeFileSync(paths.claudeSettingsPath, JSON.stringify({ model: "opus", hooks: {} }));

    const result = installFleetHooks({ paths, port: 8477 });

    expect(fs.existsSync(result.scriptPath)).toBe(true);
    expect(fs.statSync(result.scriptPath).mode & 0o111).toBeGreaterThan(0);
    expect(fs.existsSync(`${paths.claudeSettingsPath}.conductor-tg.bak`)).toBe(true);
    expect(fleetHooksInstalled(paths)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsPath, "utf8")) as Record<string, unknown>;
    expect(settings.model).toBe("opus");
    expect(Object.keys(settings.hooks as object)).toContain("Notification");
  });

  it("round-trips cleanly through uninstall", () => {
    const home = makeHome();
    const paths = defaultHookInstallPaths(path.join(home, "support"), home);
    fs.mkdirSync(path.dirname(paths.claudeSettingsPath), { recursive: true });
    fs.writeFileSync(
      paths.claudeSettingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/tool" }] }] } }),
    );

    installFleetHooks({ paths, port: 8477 });
    uninstallFleetHooks(paths);

    expect(fleetHooksInstalled(paths)).toBe(false);
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsPath, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe("/other/tool");
  });
});
