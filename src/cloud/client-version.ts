/**
 * What this Mac tells the relay about itself (#133, docs/cloud-layer.md "Old Mac apps"): `x-squeak-client: mac/<version>` on
 * every relay call, and the one-line state when the relay answers 426 because this app is older than the Pond routes need.
 * The version is the Mac app's (the claim file `app-install.json` it writes beside the daemon, orphan-watch.ts), or
 * `SQUEAK_MAC_VERSION`; a daemon run by hand says `mac/dev`, which the relay lets through.
 */
import fs from "node:fs";
import path from "node:path";

export const CLIENT_HEADER = "x-squeak-client";
/** The relay's sentence for an old Mac, and the one line the Mac shows; made here so no surface words it. */
export const UPDATE_LINE = "Update Squeak to keep using shared Ponds";
export const UPDATE_REQUIRED_STATUS = 426;

let version = (process.env.SQUEAK_MAC_VERSION ?? "").trim() || "dev";

/** The Mac app's version from the claim file in the support folder; unchanged when there is none. */
export function loadMacVersion(supportDir: string): string {
  try {
    const claim = JSON.parse(fs.readFileSync(path.join(supportDir, "app-install.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof claim.version === "string" && /^[A-Za-z0-9._+-]{1,40}$/.test(claim.version)) version = claim.version;
  } catch {
    // No claim (a dev build, a daemon run by hand): keep what was set.
  }
  return version;
}

export function setMacVersion(value: string): void {
  version = value;
}

export function macClientHeaders(): Record<string, string> {
  return { [CLIENT_HEADER]: `mac/${version}` };
}

/** Whether the relay has refused this app as too old; a restart onto the new app clears it. */
class UpdateGate {
  private on = false;
  private readonly listeners = new Set<() => void>();
  get required(): boolean {
    return this.on;
  }
  /** Looks at a relay answer: 426 marks the gate. Returns the same response for chaining. */
  see(response: { status: number }): void {
    if (response.status !== UPDATE_REQUIRED_STATUS || this.on) return;
    this.on = true;
    for (const l of this.listeners) l();
  }
  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  reset(): void {
    this.on = false;
  }
}

export const updateGate = new UpdateGate();

/** `fetch` for a relay call that notes a 426 (the default of every relay client here; tests pass their own). */
export const relayFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(url, init);
  updateGate.see(response);
  return response;
};
