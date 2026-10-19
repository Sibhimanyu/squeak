import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cliqHandlerScripts, runCliqRelay, setEnvValues } from "./setup.js";

function tempEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, contents);
  return file;
}

describe("setEnvValues", () => {
  it("updates keys in place, uncomments a switched-off one, appends the rest, keeps everything else", () => {
    const file = tempEnv("# comment\nSQUEAK_BOT_TOKEN=abc\n# SQUEAK_CLIQ_RELAY_ID=old\nOTHER=1\n");
    setEnvValues(file, { SQUEAK_CLIQ_RELAY_ID: "new", SQUEAK_CLIQ_RELAY_SECRET: "s" });

    expect(fs.readFileSync(file, "utf8")).toBe(
      "# comment\nSQUEAK_BOT_TOKEN=abc\nSQUEAK_CLIQ_RELAY_ID=new\nOTHER=1\nSQUEAK_CLIQ_RELAY_SECRET=s\n",
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("runCliqRelay", () => {
  it("makes a relay once, keeps it on a rerun, and never prints the secret", () => {
    const file = tempEnv("SQUEAK_REMOTE_PROJECT=squeak-test\n");
    const first = runCliqRelay(file, { SQUEAK_REMOTE_PROJECT: "squeak-test" }, []);
    const env = Object.fromEntries(
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=") as [string, string]),
    );
    expect(env.SQUEAK_CLIQ_RELAY_ID).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.SQUEAK_CLIQ_RELAY_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(first.join("\n")).not.toContain(env.SQUEAK_CLIQ_RELAY_SECRET);

    const handlers = path.join(path.dirname(file), "cliq-handlers.txt");
    expect(fs.statSync(handlers).mode & 0o777).toBe(0o600);
    const scripts = fs.readFileSync(handlers, "utf8");
    expect(scripts).toContain(`zoho.encryption.hmacsha256("${env.SQUEAK_CLIQ_RELAY_SECRET}",box,"hex")`);
    expect(scripts).toContain(
      `/projects/squeak-test/databases/(default)/documents/cliq/${env.SQUEAK_CLIQ_RELAY_ID}/inbox`,
    );

    runCliqRelay(file, { SQUEAK_REMOTE_PROJECT: "squeak-test", ...env }, []);
    expect(fs.readFileSync(file, "utf8")).toContain(`SQUEAK_CLIQ_RELAY_SECRET=${env.SQUEAK_CLIQ_RELAY_SECRET}`);

    runCliqRelay(file, { SQUEAK_REMOTE_PROJECT: "squeak-test", ...env }, ["--rotate"]);
    expect(fs.readFileSync(file, "utf8")).not.toContain(`SQUEAK_CLIQ_RELAY_SECRET=${env.SQUEAK_CLIQ_RELAY_SECRET}`);
  });

  it("needs the Firebase project", () => {
    expect(() => runCliqRelay(tempEnv(""), {}, [])).toThrow(/SQUEAK_REMOTE_PROJECT/);
  });
});

describe("cliqHandlerScripts", () => {
  it("writes the three handlers, each signing and posting its record", () => {
    const scripts = cliqHandlerScripts({ projectId: "p", relayId: "r".repeat(43), secret: "s".repeat(64) });
    expect(scripts.match(/zoho\.encryption\.hmacsha256/g)).toHaveLength(3);
    expect(scripts.match(/invokeurl/g)).toHaveLength(3);
    for (const kind of ['"kind","message"', '"kind","button"', '"kind","reply"']) {
      expect(scripts).toContain(kind);
    }
  });
});

describe("cliqHandlerScripts on the Realtime Database", () => {
  it("posts plain JSON to the relay's inbox under the database, still signed", () => {
    const db = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app";
    const relay = "r".repeat(43);
    const scripts = cliqHandlerScripts({ projectId: "p", relayId: relay, secret: "s".repeat(64), databaseUrl: db });
    expect(scripts.match(new RegExp(`url :"${db}/cliq/${relay}/inbox\\.json"`, "g"))).toHaveLength(3);
    expect(scripts).not.toContain("firestore.googleapis.com");
    expect(scripts).not.toContain("stringValue");
    expect(scripts.match(/zoho\.encryption\.hmacsha256/g)).toHaveLength(3);
    expect(scripts).toContain('payload = {"box":box,"sig":sig,"at":zoho.currenttime.toLong()};');
  });
});
