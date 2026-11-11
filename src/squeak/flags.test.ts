import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { askFormatEnabled } from "../fleet/ask-format.js";
import { FLAGS, FlagRegistry, flag, initFlags, readFlagFile, type FlagName } from "./flags.js";

const dirs: string[] = [];
function supportDir(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-flags-"));
  dirs.push(dir);
  if (content !== undefined) fs.writeFileSync(path.join(dir, "flags.json"), content);
  return dir;
}

afterEach(() => {
  initFlags(supportDir());
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const values = [undefined, "", "off", "OFF", " Off ", "on", "0", "false", "no", "working", "1", "yes"];

// The expressions each call site used before the registry, kept here verbatim.
const legacy: Record<FlagName, (raw: string | undefined) => boolean> = {
  "remote.verbose": (raw) => raw?.trim().toLowerCase() !== "off",
  "remote.local": (raw) => raw?.trim().toLowerCase() !== "off",
  caffeinate: (raw) => raw?.trim().toLowerCase() !== "off",
  askFormat: (raw) => !/^(?:off|0|false|no)$/i.test((raw ?? "").trim()),
};

describe("flag registry matches the old parsing", () => {
  for (const definition of FLAGS) {
    it(`${definition.name} (${definition.env})`, () => {
      const registry = new FlagRegistry();
      for (const raw of values) {
        const env = raw === undefined ? {} : { [definition.env]: raw };
        expect(registry.flag(definition.name, env), `${definition.env}=${JSON.stringify(raw)}`).toBe(
          legacy[definition.name](raw),
        );
      }
      expect(registry.flag(definition.name, {})).toBe(definition.default);
    });
  }

  it("askFormatEnabled keeps its signature and meaning", () => {
    expect(askFormatEnabled({})).toBe(true);
    expect(askFormatEnabled({ SQUEAK_ASK_FORMAT: "No" })).toBe(false);
    expect(askFormatEnabled({ SQUEAK_ASK_FORMAT: "on" })).toBe(true);
  });
});

describe("flags.json", () => {
  it("overrides the default, and the environment wins over the file", () => {
    const registry = new FlagRegistry(readFlagFile(supportDir('{"remote.local": false, "askFormat": false}')));
    expect(registry.resolve("remote.local", {})).toEqual({ value: false, source: "file" });
    expect(registry.resolve("remote.verbose", {})).toEqual({ value: true, source: "default" });
    expect(registry.resolve("remote.local", { SQUEAK_REMOTE_LOCAL: "on" })).toEqual({ value: true, source: "env" });
    expect(registry.resolve("askFormat", { SQUEAK_ASK_FORMAT: "off" })).toEqual({ value: false, source: "env" });
  });

  it("is read once at initFlags and drives flag()", () => {
    const dir = supportDir('{"remote.verbose": false}');
    initFlags(dir);
    fs.writeFileSync(path.join(dir, "flags.json"), "{}");
    expect(flag("remote.verbose", {})).toBe(false);
  });

  it("ignores a missing, invalid, non-object file and unknown or non-boolean entries", () => {
    expect(readFlagFile(supportDir())).toEqual({});
    expect(readFlagFile(supportDir("{nope"))).toEqual({});
    expect(readFlagFile(supportDir("[true]"))).toEqual({});
    expect(readFlagFile(supportDir('{"remote.local": "off", "nope": true, "caffeinate": false}'))).toEqual({
      caffeinate: false,
    });
  });

  it("lists name, value and source", () => {
    const list = new FlagRegistry({ caffeinate: false }).list({ SQUEAK_REMOTE_LOCAL: "off" });
    expect(list.find((item) => item.name === "caffeinate")).toMatchObject({ value: false, source: "file" });
    expect(list.find((item) => item.name === "remote.local")).toMatchObject({ value: false, source: "env" });
    expect(list.find((item) => item.name === "askFormat")).toMatchObject({ value: true, source: "default" });
  });
});
