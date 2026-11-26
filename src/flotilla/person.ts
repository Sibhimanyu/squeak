import { execFileSync } from "node:child_process";
import os from "node:os";

type Run = (file: string, args: string[]) => string;
const run: Run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });

const clean = (value: string | undefined): string => (value ?? "").replace(/\p{C}/gu, "").trim().slice(0, 100);

/**
 * The hostname an older install saved as the Mac's Nest: the default a computer name may replace. A person's name is
 * never read from the Mac: it is their Squeak account's.
 */
export function oldDefaults(): { nest: string } {
  return { nest: os.hostname().replace(/\.local$/, "") };
}

/** The Mac's computer name (`scutil --get ComputerName`), else the hostname. */
export function computerName(exec: Run = run, host = os.hostname()): string {
  try {
    const name = clean(exec("scutil", ["--get", "ComputerName"]));
    if (name) return name;
  } catch {
    // not set
  }
  return host.replace(/\.local$/, "");
}
