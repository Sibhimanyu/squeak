import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseCredentials, resolveClaudeCredentials } from "./claude-credentials.js";

const NOW = 1_800_000_000_000;
const SECRET = "sk-ant-oat01-SECRET-TOKEN";

function creds(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: SECRET,
      expiresAt: NOW + 3_600_000,
      scopes: ["user:inference", "user:profile"],
      ...over,
    },
  });
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "squeak-creds-"));
}

function write(dir: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), text);
}

describe("resolveClaudeCredentials", () => {
  it("reads the default ~/.claude file and never touches the Keychain when it exists", async () => {
    const home = tempHome();
    write(path.join(home, ".claude"), creds());
    const readKeychain = vi.fn(async () => creds({ accessToken: "other" }));
    const result = await resolveClaudeCredentials({
      env: {},
      homedir: () => home,
      platform: "darwin",
      now: () => NOW,
      readKeychain,
    });
    expect(result).toEqual({ ok: true, accessToken: SECRET });
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("uses CLAUDE_CONFIG_DIR exclusively, and never the global Keychain", async () => {
    const home = tempHome();
    const custom = tempHome();
    write(path.join(home, ".claude"), creds({ accessToken: "default-account" }));
    write(custom, creds({ accessToken: "custom-account" }));
    const readKeychain = vi.fn(async () => creds());
    const deps = { homedir: () => home, platform: "darwin" as const, now: () => NOW, readKeychain };
    expect(await resolveClaudeCredentials({ ...deps, env: { CLAUDE_CONFIG_DIR: custom } })).toEqual({
      ok: true,
      accessToken: "custom-account",
    });
    const empty = tempHome();
    const missing = await resolveClaudeCredentials({ ...deps, env: { CLAUDE_CONFIG_DIR: empty } });
    expect(missing).toMatchObject({ ok: false });
    expect(JSON.stringify(missing)).toMatch(/selected Claude config directory/);
    expect(JSON.stringify(missing)).not.toMatch(/not signed in on this Mac/);
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("falls back to the Keychain on macOS only when the default file is missing", async () => {
    const home = tempHome();
    const readKeychain = vi.fn(async () => creds({ accessToken: "from-keychain" }));
    const base = { env: {}, homedir: () => home, now: () => NOW, readKeychain };
    expect(await resolveClaudeCredentials({ ...base, platform: "darwin" })).toEqual({
      ok: true,
      accessToken: "from-keychain",
    });
    expect(readKeychain).toHaveBeenCalledTimes(1);
    expect(await resolveClaudeCredentials({ ...base, platform: "linux" })).toMatchObject({ ok: false });
    expect(readKeychain).toHaveBeenCalledTimes(1);
  });

  it("does not swap an unusable default file for a Keychain token", async () => {
    const home = tempHome();
    write(path.join(home, ".claude"), creds({ expiresAt: NOW - 1 }));
    const readKeychain = vi.fn(async () => creds());
    const result = await resolveClaudeCredentials({
      env: {},
      homedir: () => home,
      platform: "darwin",
      now: () => NOW,
      readKeychain,
    });
    expect(result).toMatchObject({ ok: false });
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("reports a Keychain failure without its message", async () => {
    const result = await resolveClaudeCredentials({
      env: {},
      homedir: () => tempHome(),
      platform: "darwin",
      now: () => NOW,
      readKeychain: async () => {
        throw new Error(`security: ${SECRET}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reports an unreadable file without its message", async () => {
    const result = await resolveClaudeCredentials({
      env: {},
      homedir: () => "/x",
      platform: "linux",
      now: () => NOW,
      readFile: async () => {
        throw new Error(`EACCES ${SECRET}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("parseCredentials", () => {
  it("accepts a live credential with the usage scope", () => {
    expect(parseCredentials(creds(), NOW)).toEqual({ ok: true, accessToken: SECRET });
  });

  it("rejects an expired credential, including one expiring exactly now", () => {
    expect(parseCredentials(creds({ expiresAt: NOW }), NOW)).toMatchObject({ ok: false });
    expect(parseCredentials(creds({ expiresAt: NOW - 1000 }), NOW)).toMatchObject({ ok: false });
  });

  it("rejects an inference-only credential", () => {
    const r = parseCredentials(creds({ scopes: ["user:inference"] }), NOW);
    expect(r).toMatchObject({ ok: false });
    expect(parseCredentials(creds({ scopes: undefined }), NOW)).toMatchObject({ ok: false });
  });

  it("explains an MCP-only payload", () => {
    const r = parseCredentials(JSON.stringify({ mcpOAuth: { server: { accessToken: SECRET } } }), NOW);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/tool sign-ins/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("trims a padded token and rejects one that cannot be a header value", () => {
    expect(parseCredentials(creds({ accessToken: `  ${SECRET}\n` }), NOW)).toEqual({ ok: true, accessToken: SECRET });
    for (const accessToken of [`${SECRET} extra`, `${SECRET}\r\nX-Evil: 1`, `${SECRET}\u0000`, `${SECRET}é`, " \t "]) {
      const r = parseCredentials(creds({ accessToken }), NOW);
      expect(r).toEqual({ ok: false, error: "Claude Code's saved sign-in is not readable." });
    }
  });

  it("rejects malformed shapes without echoing the text", () => {
    for (const text of [
      "not json " + SECRET,
      "null",
      "[]",
      creds({ accessToken: "" }),
      creds({ accessToken: 5 }),
      creds({ expiresAt: "soon" }),
      creds({ expiresAt: null }),
    ]) {
      const r = parseCredentials(text, NOW);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });
});
