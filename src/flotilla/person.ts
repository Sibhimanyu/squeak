import { execFileSync } from "node:child_process";
import os from "node:os";

type Run = (file: string, args: string[]) => string;
const run: Run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });

const clean = (value: string | undefined): string => (value ?? "").replace(/\p{C}/gu, "").trim().slice(0, 100);

/** The login name and hostname an older install saved as the owner's name and Nest: the defaults a real name may replace. */
export function oldDefaults(): { name: string; nest: string } {
  return { name: os.userInfo().username, nest: os.hostname().replace(/\.local$/, "") };
}

/** The person's full name (macOS `id -F`), never the short login name; the login name only when the Mac has no full name. */
export function personName(exec: Run = run, login = os.userInfo().username): string {
  try {
    const full = clean(exec("id", ["-F"]));
    if (full) return full;
  } catch {
    // no full name
  }
  return login;
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
