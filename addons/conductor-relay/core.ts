/**
 * The only place this add-on reaches into Squeak's core at run time (everything else it takes from core is a type,
 * erased at build). Core's shared pieces are loaded by path because the same file runs from two layouts:
 * `addons/conductor-relay/` beside `src/` (tests, tsx) and `dist/addons/conductor-relay/` inside the built daemon.
 */
import fs from "node:fs";

const built = fs.existsSync(new URL("../../squeak/cli.js", import.meta.url));
const base = built ? "../../" : "../../src/";

const log = (await import(`${base}utils/logger.js`)) as typeof import("../../src/utils/logger.js");
const retire = (await import(`${base}fleet/relay-retire.js`)) as typeof import("../../src/fleet/relay-retire.js");
const paired = (await import(
  `${base}fleet/relay-paired-devices.js`
)) as typeof import("../../src/fleet/relay-paired-devices.js");

export const logger = log.logger;
export const {
  OVERRIDE_KEY,
  ENABLE_KEY,
  KEYCHAIN_SERVICE,
  PAIRED_DEVICES_ACCOUNT,
  DEFAULT_RELAY_PORT,
  relayOverrideValue,
  reverseRelay,
  plainError,
  realEffects,
} = retire;
export const { mergePairedDevice, parsePairedDevices } = paired;
export type { RelayEffects, RelayStateFile, SettingsHandle, DeviceCredentials } from "../../src/fleet/relay-retire.js";
