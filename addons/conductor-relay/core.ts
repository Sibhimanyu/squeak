/**
 * The one place this add-on reaches into the Conductor add-on and Squeak's core at run time. The add-on is bundled
 * (`scripts/addons.sh`), so these are plain imports; everything here is Conductor-side logic that lives in
 * `addons/conductor/` (the relay's settings and Keychain effects, and the reversal of what it changed).
 */
export { logger } from "../../src/utils/logger.js";
export {
  OVERRIDE_KEY,
  ENABLE_KEY,
  KEYCHAIN_SERVICE,
  PAIRED_DEVICES_ACCOUNT,
  DEFAULT_RELAY_PORT,
  relayOverrideValue,
  reverseRelay,
  plainError,
  realEffects,
} from "../conductor/relay-retire.js";
export { mergePairedDevice, parsePairedDevices } from "../conductor/relay-paired-devices.js";
export type { RelayEffects, RelayStateFile, SettingsHandle, DeviceCredentials } from "../conductor/relay-retire.js";
