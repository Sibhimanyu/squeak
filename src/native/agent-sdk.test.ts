import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizePin, renderAgentSdkPin } from "./agent-sdk-pin-gen.js";
import { AGENT_SDK_PIN } from "./agent-sdk-pin.js";
import { AgentSdkUnavailableError, loadAgentSdk, loadAgentSdkIfPresent, resetAgentSdkForTests } from "./agent-sdk.js";

const NAME = "@anthropic-ai/claude-agent-sdk";
let tmp: string;
let server: http.Server;
let registry: string;
let hits: number;
let body: Buffer;

function fakeTarball(version: string): Buffer {
  const src = path.join(tmp, "src");
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(path.join(src, "package"), { recursive: true });
  fs.writeFileSync(path.join(src, "package/package.json"), JSON.stringify({ name: NAME, version }));
  fs.writeFileSync(
    path.join(src, "package/sdk.mjs"),
    "export const query = () => 'fake'; export const marker = 'fetched';\n",
  );
  const out = path.join(tmp, "fake.tgz");
  execFileSync("tar", ["-czf", out, "-C", src, "package"]);
  return fs.readFileSync(out);
}
const integrity = (b: Buffer) => `sha512-${crypto.createHash("sha512").update(b).digest("base64")}`;
const missing = () =>
  Promise.reject(Object.assign(new Error(`Cannot find package '${NAME}'`), { code: "ERR_MODULE_NOT_FOUND" }));

beforeEach(async () => {
  resetAgentSdkForTests();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sdk-"));
  hits = 0;
  body = fakeTarball("1.2.3");
  server = http.createServer((req, res) => {
    hits++;
    expect(req.url).toBe(`/${NAME}/-/claude-agent-sdk-1.2.3.tgz`);
    setTimeout(() => res.end(body), 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const pinFor = (b: Buffer) => ({
  version: "1.2.3",
  packages: [{ name: NAME, version: "1.2.3", integrity: integrity(b) }],
});
const support = () => path.join(tmp, "support");

describe("loadAgentSdk", () => {
  it("uses an installed copy and never touches the network", async () => {
    const sdk = { marker: "installed" } as never;
    const got = await loadAgentSdk({
      supportDir: support(),
      pin: pinFor(body),
      registry,
      importInstalled: async () => sdk,
    });
    expect(got).toBe(sdk);
    expect(hits).toBe(0);
  });

  it("fetches, verifies, extracts and loads; the next call reuses it", async () => {
    let notes = 0;
    const opts = {
      supportDir: support(),
      pin: pinFor(body),
      registry,
      importInstalled: missing,
      onFetch: () => notes++,
    };
    const sdk = (await loadAgentSdk(opts)) as unknown as { marker: string };
    expect(sdk.marker).toBe("fetched");
    expect(notes).toBe(1);
    expect(fs.readdirSync(path.join(support(), "agent-sdk"))).toEqual(["1.2.3"]);
    resetAgentSdkForTests();
    expect(await loadAgentSdkIfPresent(opts)).not.toBeNull();
    await loadAgentSdk(opts);
    expect(hits).toBe(1);
  });

  it("refuses a download that does not match the pin and leaves nothing behind", async () => {
    const wrong = pinFor(Buffer.from("something else"));
    await expect(
      loadAgentSdk({ supportDir: support(), pin: wrong, registry, importInstalled: missing }),
    ).rejects.toThrow(
      /Couldn't download Claude's agent kit from npm: .*checksum.*Check the internet connection and send again\./,
    );
    expect(fs.readdirSync(path.join(support(), "agent-sdk"))).toEqual([]);
    await expect(
      loadAgentSdkIfPresent({ supportDir: support(), pin: wrong, importInstalled: missing }),
    ).resolves.toBeNull();
  });

  it("says why when npm is unreachable", async () => {
    server.close();
    const err = await loadAgentSdk({
      supportDir: support(),
      pin: pinFor(body),
      registry,
      importInstalled: missing,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentSdkUnavailableError);
    expect(fs.readdirSync(path.join(support(), "agent-sdk"))).toEqual([]);
  });

  it("fetches once for concurrent calls", async () => {
    const opts = { supportDir: support(), pin: pinFor(body), registry, importInstalled: missing };
    await Promise.all([loadAgentSdk(opts), loadAgentSdk(opts), loadAgentSdk(opts)]);
    expect(hits).toBe(1);
  });

  it("a second process waits on the lock and then uses the first's download", async () => {
    const opts = { supportDir: support(), pin: pinFor(body), registry, importInstalled: missing };
    const first = loadAgentSdk(opts);
    await new Promise((r) => setTimeout(r, 10));
    resetAgentSdkForTests(); // as if another process: no shared in-process promise
    const second = loadAgentSdk(opts);
    await Promise.all([first, second]);
    expect(hits).toBe(1);
  });
});

describe("agent-sdk pin", () => {
  it("matches package.json and package-lock.json", () => {
    const expected = renderAgentSdkPin(
      fs.readFileSync(path.resolve(__dirname, "../../package-lock.json"), "utf8"),
      fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    );
    expect(expected).toContain(AGENT_SDK_PIN.version);
    expect(normalizePin(expected)).toBe(
      normalizePin(fs.readFileSync(path.resolve(__dirname, "agent-sdk-pin.ts"), "utf8")),
    );
  });
});
