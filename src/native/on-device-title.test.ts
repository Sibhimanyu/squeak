import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { onDeviceTitleCall } from "./on-device.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "on-device-title-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const writeHelper = fake("write-ok", `cat >/dev/null; echo '{"ok":true,"text":"Zoom review fixes"}'`);
const offHelper = fake("off", `cat >/dev/null; echo '{"ok":false,"unavailable":true,"reason":"off"}'`);
const req = { prompt: "p", system: "s", signal: new AbortController().signal };

describe("onDeviceTitleCall", () => {
  it("answers from the Mac's own model and never asks Haiku", async () => {
    const haiku = vi.fn(async () => "From Haiku");
    const call = onDeviceTitleCall({ setting: () => "on-device", helper: () => writeHelper, fallback: haiku });
    expect(await call(req)).toBe("Zoom review fixes");
    expect(haiku).not.toHaveBeenCalled();
  });

  it("falls to Haiku when the helper is missing or unavailable, or the setting is haiku", async () => {
    const cases = [
      ["on-device", undefined],
      ["on-device", offHelper],
      ["haiku", writeHelper],
    ] as const;
    for (const [setting, helper] of cases) {
      const haiku = vi.fn(async () => "From Haiku");
      const call = onDeviceTitleCall({ setting: () => setting, helper: () => helper, fallback: haiku });
      expect(await call(req)).toBe("From Haiku");
    }
  });
});
