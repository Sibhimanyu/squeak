import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccountSwitcher, listClaudeAccounts, type ClaudeAccountPaths } from "./claude-accounts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: { accounts?: Record<string, unknown>; active?: string; exe?: boolean; rawConfig?: string } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-"));
  dirs.push(dir);
  const accountsDir = path.join(dir, "accounts");
  fs.mkdirSync(accountsDir);
  const accounts = options.accounts ?? {
    work: { emailAddress: "w@x.com", organizationType: "claude_team" },
    home: { emailAddress: "h@x.com", organizationType: "claude_max" },
  };
  for (const [name, meta] of Object.entries(accounts)) {
    fs.writeFileSync(path.join(accountsDir, `${name}.json`), typeof meta === "string" ? meta : JSON.stringify(meta));
  }
  const configFile = path.join(dir, "claude.json");
  fs.writeFileSync(
    configFile,
    options.rawConfig ?? JSON.stringify({ oauthAccount: { emailAddress: options.active ?? "w@x.com" } }),
  );
  const exe = path.join(dir, "claude-swap");
  if (options.exe !== false) fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  const paths: ClaudeAccountPaths = { accountsDir, configFile, executables: [exe] };
  return { paths, configFile, exe };
}

describe("listClaudeAccounts", () => {
  it("lists saved accounts and finds the active one by email", () => {
    const { paths } = setup({ active: "h@x.com" });
    expect(listClaudeAccounts(paths)).toEqual({
      available: true,
      current: "home",
      accounts: [
        { name: "home", email: "h@x.com", plan: "claude_max" },
        { name: "work", email: "w@x.com", plan: "claude_team" },
      ],
    });
  });

  it("is unavailable without the executable or with fewer than two accounts", () => {
    expect(listClaudeAccounts(setup({ exe: false }).paths).available).toBe(false);
    const one = setup({ accounts: { solo: { emailAddress: "a@x.com", organizationType: "claude_pro" } } });
    expect(listClaudeAccounts(one.paths).available).toBe(false);
  });

  it("survives malformed or missing files", () => {
    const bad = setup({
      accounts: { ok: { emailAddress: "a@x.com" }, broken: "{nope", arr: "[1]" },
      rawConfig: "not json",
    });
    const list = listClaudeAccounts(bad.paths);
    expect(list.current).toBeNull();
    expect(list.accounts.map((a) => a.name)).toEqual(["ok"]);
    const none = listClaudeAccounts({ accountsDir: "/nonexistent/a", configFile: "/nonexistent/c", executables: [] });
    expect(none).toEqual({ available: false, current: null, accounts: [] });
  });
});

describe("ClaudeAccountSwitcher", () => {
  it("runs the script with exactly use and the name, then reports the re-read current", async () => {
    const s = setup();
    const run = vi.fn(async () => {
      fs.writeFileSync(s.configFile, JSON.stringify({ oauthAccount: { emailAddress: "h@x.com" } }));
    });
    const out = await new ClaudeAccountSwitcher(s.paths, run).use("home");
    expect(run).toHaveBeenCalledWith(s.exe, ["use", "home"]);
    expect(out).toEqual({ ok: true, current: "home" });
  });

  it("refuses names that are invalid or not saved, without running anything", async () => {
    const s = setup();
    const run = vi.fn(async () => undefined);
    const switcher = new ClaudeAccountSwitcher(s.paths, run);
    for (const name of ["nobody", "../x", "a b", "", "x".repeat(41), 5, null]) {
      expect((await switcher.use(name)).ok).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("gives a fixed sentence when the script fails, never its output", async () => {
    const s = setup();
    const run = vi.fn(async () => {
      throw new Error("sk-ant-secret");
    });
    const out = await new ClaudeAccountSwitcher(s.paths, run).use("home");
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("does one at a time", async () => {
    const s = setup();
    let release = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const switcher = new ClaudeAccountSwitcher(s.paths, run);
    const first = switcher.use("home");
    await Promise.resolve();
    expect((await switcher.use("home")).ok).toBe(false);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });
});
