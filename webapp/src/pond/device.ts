// This browser as a device of the signed-in account: its key, registered once with the relay (`POST /account/devices`, kind
// web) so the account's device list shows it and removing it there removes it from every Pond.

import { loadIdentity, type DeviceIdentity, type KeyVault } from "../device/vault.js";
import type { Relay } from "../relay/client.js";

export interface Device {
  /** The key and its id; registered with the relay by the time this resolves (a failure to register is retried on the next call). */
  ready(): Promise<DeviceIdentity>;
}

export const DEVICE_NAME = "Web browser";

export function createDevice(o: { relay: Relay; token: string; userId: string; vault: KeyVault }): Device {
  let identity: Promise<DeviceIdentity> | null = null;
  let registered = false;
  return {
    async ready() {
      const id = await (identity ??= loadIdentity(o.vault, o.userId));
      if (!registered) {
        const result = await o.relay.registerDevice(o.token, { publicKey: id.publicKey, name: DEVICE_NAME });
        registered = result === "ok";
      }
      return id;
    },
  };
}
