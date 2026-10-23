import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ASK_FORMAT_EXAMPLE_CHOICE,
  ASK_FORMAT_EXAMPLE_CONFIRM,
  ASK_FORMAT_TEXT,
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  applyAskFormat,
  askFormatEnabled,
  defaultAskFormatPaths,
  installAskFormat,
  mergeAskFormatHook,
  removeAskFormatBlock,
  removeAskFormatHook,
  renderAskFormatScript,
  uninstallAskFormat,
  upsertAskFormatBlock,
} from "./ask-format.js";
import { closingQuestion, parseChoices } from "./choices.js";

const dirs: string[] = [];
function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-format-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("the instruction and the parser agree", () => {
  it("reads the choice example as a question with three options and a recommendation", () => {
    const parsed = parseChoices(ASK_FORMAT_EXAMPLE_CHOICE);
    expect(parsed?.question).toBe("Which way should I release?");
    expect(parsed?.options.map((o) => o.letter)).toEqual(["A", "B", "C"]);
    expect(parsed?.options[0]?.title).toBe("Merge #177 first, then release 0.19.8");
    expect(parsed?.recommended).toBe("A");
    expect(closingQuestion(ASK_FORMAT_EXAMPLE_CHOICE)).toBe("Which way should I release?");
  });

  it("reads the yes/no example as two buttons, Yes recommended", () => {
    const parsed = parseChoices(ASK_FORMAT_EXAMPLE_CONFIRM);
    expect(parsed?.options.map((o) => o.letter)).toEqual(["A", "B"]);
    expect(parsed?.recommended).toBe("A");
    expect(closingQuestion(ASK_FORMAT_EXAMPLE_CONFIRM)).not.toBeNull();
  });

  it("embeds both examples verbatim in the instruction", () => {
    expect(ASK_FORMAT_TEXT).toContain(ASK_FORMAT_EXAMPLE_CHOICE);
    expect(ASK_FORMAT_TEXT).toContain(ASK_FORMAT_EXAMPLE_CONFIRM);
  });
});

describe("the SessionStart script", () => {
  it("prints the documented JSON and exits 0", () => {
    const dir = makeHome();
    const script = path.join(dir, "ask-format.sh");
    fs.writeFileSync(script, renderAskFormatScript(`${ASK_FORMAT_TEXT}\nit's "quoted" $HOME \`tick\``), {
      mode: 0o755,
    });
    const out = execFileSync("/bin/sh", [script], { input: "" }).toString();
    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(ASK_FORMAT_EXAMPLE_CHOICE);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(`it's "quoted" $HOME \`tick\``);
  });
});

describe("settings.json hook", () => {
  const script = "/tmp/squeak/ask-format.sh";
  it("merges beside other tools' hooks, idempotently", () => {
    const other = { type: "command", command: "/usr/local/bin/other" };
    const existing = { model: "x", hooks: { SessionStart: [{ hooks: [other] }] } };
    const first = mergeAskFormatHook(existing, script);
    expect(first.changed).toBe(true);
    const groups = (first.config.hooks as { SessionStart: Array<{ hooks: unknown[] }> }).SessionStart;
    expect(groups).toHaveLength(2);
    expect(groups[0]?.hooks).toEqual([other]);
    expect(first.config.model).toBe("x");
    expect(mergeAskFormatHook(first.config, script).changed).toBe(false);
  });

  it("removes only its own entry", () => {
    const other = { type: "command", command: "/usr/local/bin/other" };
    const merged = mergeAskFormatHook({ hooks: { SessionStart: [{ hooks: [other] }] } }, script).config;
    const removed = removeAskFormatHook(merged);
    expect(removed.changed).toBe(true);
    expect(removed.config).toEqual({ hooks: { SessionStart: [{ hooks: [other] }] } });
    const alone = removeAskFormatHook(mergeAskFormatHook({}, script).config);
    expect((alone.config.hooks as Record<string, unknown>).SessionStart).toBeUndefined();
    expect(removeAskFormatHook({}).changed).toBe(false);
  });
});

describe("AGENTS.md block", () => {
  it("inserts into an empty or existing file and preserves the rest", () => {
    expect(upsertAskFormatBlock("")).toBe(`${CODEX_BLOCK_START}\n${ASK_FORMAT_TEXT}\n${CODEX_BLOCK_END}\n`);
    const mine = "# My rules\n\nBe terse.\n";
    const withBlock = upsertAskFormatBlock(mine);
    expect(withBlock.startsWith(mine)).toBe(true);
    expect(withBlock).toContain(CODEX_BLOCK_START);
    expect(upsertAskFormatBlock(withBlock)).toBe(withBlock);
    expect(removeAskFormatBlock(withBlock)).toBe(mine);
  });

  it("replaces a stale block in place", () => {
    const stale = `before\n\n${CODEX_BLOCK_START}\nold text\n${CODEX_BLOCK_END}\n\nafter\n`;
    const next = upsertAskFormatBlock(stale);
    expect(next).not.toContain("old text");
    expect(next.startsWith("before\n\n")).toBe(true);
    expect(next.endsWith("\n\nafter\n")).toBe(true);
    expect(removeAskFormatBlock(next)).toBe("before\n\nafter\n");
  });

  it("leaves a file without the block alone", () => {
    expect(removeAskFormatBlock("hello\n")).toBe("hello\n");
  });
});

describe("install and uninstall", () => {
  it("writes the script, settings entry and AGENTS block, backs up, and undoes only those", () => {
    const home = makeHome();
    const paths = defaultAskFormatPaths(path.join(home, "support"), home, {});
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const other = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/other" }] }] } };
    fs.writeFileSync(paths.claudeSettingsPath, JSON.stringify(other));
    fs.writeFileSync(paths.codexAgentsPath, "mine\n");

    const first = installAskFormat(paths);
    expect(first.changed).toHaveLength(2);
    expect(fs.existsSync(`${paths.claudeSettingsPath}.squeak.bak`)).toBe(true);
    expect(fs.readFileSync(`${paths.codexAgentsPath}.squeak.bak`, "utf8")).toBe("mine\n");
    expect(fs.statSync(paths.scriptPath).mode & 0o111).not.toBe(0);
    expect(installAskFormat(paths).changed).toEqual([]);

    uninstallAskFormat(paths);
    expect(JSON.parse(fs.readFileSync(paths.claudeSettingsPath, "utf8"))).toEqual(other);
    expect(fs.readFileSync(paths.codexAgentsPath, "utf8")).toBe("mine\n");
    expect(fs.existsSync(paths.scriptPath)).toBe(false);
  });

  it("SQUEAK_ASK_FORMAT=off removes instead of installing", () => {
    const home = makeHome();
    const paths = defaultAskFormatPaths(path.join(home, "support"), home, {});
    installAskFormat(paths);
    expect(askFormatEnabled({ SQUEAK_ASK_FORMAT: "off" })).toBe(false);
    expect(askFormatEnabled({})).toBe(true);
    const result = applyAskFormat(paths, { SQUEAK_ASK_FORMAT: "off" });
    expect(result.changed).toHaveLength(2);
    expect(fs.readFileSync(paths.codexAgentsPath, "utf8")).not.toContain(CODEX_BLOCK_START);
  });

  it("honours CODEX_HOME for AGENTS.md", () => {
    const paths = defaultAskFormatPaths("/s", "/h", { CODEX_HOME: "/elsewhere" });
    expect(paths.codexAgentsPath).toBe("/elsewhere/AGENTS.md");
  });
});
