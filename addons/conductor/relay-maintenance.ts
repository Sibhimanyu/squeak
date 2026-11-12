import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddonContext, AddonUninstallStep } from "../../src/addons.js";
import { ENABLE_KEY, OVERRIDE_KEY, realEffects, retireStaleRelay, reverseRelay } from "./relay-retire.js";
import { CONDUCTOR_ROUTE_SERVICE } from "./route.js";

/**
 * What this add-on does about Conductor's old loopback relay, whether or not the add-on is enabled: it protects
 * installs. The relay add-on (dev only, `addons/conductor-relay/`) redirects Conductor's Remote Control host to a
 * loopback server; an install set up while it shipped, or whose relay add-on is gone, has to be put back.
 */

const SQUEAK_SETTINGS_MARK = "http://127.0.0.1:";

function effectsFor(supportDir: string, dbPath: string) {
  return realEffects({ conductorDbPath: dbPath, statePath: path.join(supportDir, "conductor-relay.json") });
}

async function notifyRelayRetired(keychainOk: boolean): Promise<void> {
  const body = keychainOk
    ? "Quit Conductor (Cmd-Q) and reopen it once so it goes back to its own servers."
    : "Quit and reopen Conductor once. Squeak's entry in Keychain Access could not be removed; delete it there.";
  await new Promise<void>((resolve) =>
    execFile(
      "/usr/bin/osascript",
      ["-e", `display notification "${body}" with title "Squeak handed Conductor back"`],
      () => resolve(),
    ),
  );
}

/**
 * At every start: unless the relay add-on really loaded, a Conductor still pointing at Squeak's old loopback relay is
 * put back (docs/conductor-local-feasibility.md 7.5). Reads Conductor's settings only when its database is there
 * and the Conductor app is installed; any other override, or none, is never touched.
 */
export function conductorMaintenance(context: AddonContext, dbPath: string): void {
  if (context.services.get(CONDUCTOR_ROUTE_SERVICE)) return;
  const outcome = retireStaleRelay(effectsFor(context.supportDir, dbPath));
  if (outcome.action === "reset") {
    context.logger.warn("Conductor was pointed at Squeak's old local relay; put back. Restart Conductor once.", {
      keychainRemoved: outcome.keychainOk,
    });
    void notifyRelayRetired(outcome.keychainOk);
  } else if (outcome.action === "failed") {
    context.logger.warn("could not put Conductor back from Squeak's old local relay", { reason: outcome.reason });
  }
}

/** `squeak uninstall`'s first step: hand Conductor back, with the one Keychain entry Squeak added removed. */
export function conductorUninstallStep(supportDir: string, home: string = os.homedir()): AddonUninstallStep {
  const dbPath = path.join(home, "Library/Application Support/com.conductor.app/conductor.db");
  const effects = () =>
    realEffects({
      conductorDbPath: dbPath,
      statePath: path.join(supportDir, "conductor-relay.json"),
      appPaths: ["/Applications/Conductor.app", path.join(home, "Applications/Conductor.app")],
    });
  return conductorUninstallStepWith(effects);
}

/** The step over injected effects (tests run it against a temp database). */
export function conductorUninstallStepWith(makeEffects: () => ReturnType<typeof realEffects>): AddonUninstallStep {
  let rowsChanged = false;
  let planned: string[] = [];
  return {
    id: "conductor",
    title: "Hand Conductor back",
    detail:
      "Puts Conductor's relay settings back to what they were (after backing up its database) and removes the one Keychain entry Squeak added. Done first so Conductor never points at a stopped Squeak.",
    plan() {
      const effects = makeEffects();
      if (effects.findApp() === null || !effects.dbExists()) return [];
      const state = effects.readState();
      const handle = effects.openSettings(true);
      let override: string | undefined;
      try {
        override = handle.get(OVERRIDE_KEY);
      } finally {
        handle.close();
      }
      const squeaksOverride = override?.startsWith(SQUEAK_SETTINGS_MARK) === true;
      rowsChanged = squeaksOverride || state?.previous != null;
      const createdDevice = Boolean(state?.createdDeviceId);
      if (!rowsChanged && !createdDevice) return (planned = []);
      const items: string[] = [];
      if (rowsChanged) {
        items.push(`Conductor setting ${OVERRIDE_KEY} (put back to what it was)`);
        items.push(`Conductor setting ${ENABLE_KEY} (put back to what it was)`);
      }
      if (createdDevice) items.push("Squeak's entry in Conductor's paired-devices Keychain item");
      return (planned = items);
    },
    async run() {
      const effects = makeEffects();
      try {
        effects.backupDb(effects.now());
      } catch {
        return { status: "failed", note: "Conductor's database could not be backed up." };
      }
      try {
        reverseRelay(effects);
      } catch {
        return { status: "failed", note: "Conductor's settings could not be reset." };
      }
      if (effects.readState()?.createdDeviceId) {
        return { status: "failed", note: "Squeak's Conductor Keychain entry could not be removed." };
      }
      return {
        status: "done",
        note: "Conductor is back on its own servers.",
        acted: planned,
        ...(rowsChanged ? { restart: "Conductor" } : {}),
      };
    },
  };
}
