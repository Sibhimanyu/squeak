/**
 * Conductor's paired-devices Keychain value: a JSON array of
 * `{ deviceId, name, tokenHash, createdAt, lastSeenAt }`. Adding Squeak must
 * keep every device Conductor (or an earlier run) already put there.
 */
export interface PairedDevice {
  deviceId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  [extra: string]: unknown;
}

/** Parse the stored list. Throws on anything that is not an array of objects: never guess, or the write would drop devices. */
export function parsePairedDevices(raw: string | undefined): PairedDevice[] {
  if (raw === undefined || raw.trim() === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((d) => typeof d !== "object" || d === null)) {
    throw new Error("the paired-devices Keychain item is not a list of devices");
  }
  return parsed as PairedDevice[];
}

/** The list with `device` added, replacing an entry with the same id or the same name "Squeak" from an earlier pairing. */
export function mergePairedDevice(existing: PairedDevice[], device: PairedDevice): PairedDevice[] {
  return [...existing.filter((d) => d.deviceId !== device.deviceId && d.name !== device.name), device];
}
