/**
 * Writes (or with --check, verifies) src/native/agent-sdk-pin.ts: the exact version and sha512 integrity of the
 * Claude Agent SDK tarball Squeak fetches on a Mac, taken from package-lock.json. The loader trusts this file and
 * nothing the registry says about itself. `npx tsx scripts/make-agent-sdk-pin.ts [--check]`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePin, renderAgentSdkPin } from "../src/native/agent-sdk-pin-gen.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "src/native/agent-sdk-pin.ts");

export function readExpectedPin(): string {
  return renderAgentSdkPin(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = readExpectedPin();
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    if (normalizePin(have) !== normalizePin(expected)) {
      console.error("agent-sdk-pin.ts is out of date: run `npx tsx scripts/make-agent-sdk-pin.ts` and commit it");
      process.exit(1);
    }
  } else {
    fs.writeFileSync(outFile, expected);
  }
}
