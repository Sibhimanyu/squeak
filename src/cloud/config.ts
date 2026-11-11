/**
 * `cloud.json` in the support dir (0600): which store the daemon uses and what it knows about each
 * (docs/cloud-layer.md, "Configuration"). Absent: Firebase from `SQUEAK_REMOTE_DATABASE_URL`, as before.
 */

import fs from "node:fs";
import path from "node:path";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { CatalystStore, type CatalystStoreOptions } from "./catalyst-store.js";
import { relayBaseUrl, validRelayKey, type CloudLocation } from "./location.js";
import type { CloudStore } from "./store.js";

export interface CatalystConfig {
  projectId: string | null;
  projectName: string | null;
  dc: string;
  appUrl: string | null;
  relayKey: string | null;
  deployedVersion: string | null;
}

export interface FirebaseCloudConfig {
  databaseUrl: string;
  projectId: string | null;
}

/** Squeak's hosted relay, once this Mac's account provisioned it (cloud/hosted.ts). The key is the Mac's own: never logged. */
export interface HostedConfig {
  provider: "catalyst";
  url: string;
  macKey: string;
  macId: string;
  hosted: true;
  email?: string;
}

export interface CloudConfig {
  active: "firebase" | "catalyst" | "hosted";
  firebase?: FirebaseCloudConfig;
  catalyst?: CatalystConfig;
  hosted?: HostedConfig;
}

export const RELAY_FUNCTION = "squeak_relay";

export const EMPTY_CATALYST: CatalystConfig = {
  projectId: null,
  projectName: null,
  dc: "in",
  appUrl: null,
  relayKey: null,
  deployedVersion: null,
};

export function cloudConfigPath(supportDir: string): string {
  return path.join(supportDir, "cloud.json");
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The file as it is, or null when absent or unreadable; fields of the wrong type are dropped, never trusted. */
export function readCloudConfig(supportDir: string): CloudConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cloudConfigPath(supportDir), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const config: CloudConfig = {
    active: r.active === "catalyst" || r.active === "hosted" ? r.active : "firebase",
  };
  const ho = r.hosted as Record<string, unknown> | undefined;
  if (ho && typeof ho === "object" && str(ho.url) && str(ho.macKey) && str(ho.macId)) {
    config.hosted = {
      provider: "catalyst",
      url: str(ho.url)!,
      macKey: str(ho.macKey)!,
      macId: str(ho.macId)!,
      hosted: true,
      ...(str(ho.email) ? { email: str(ho.email)! } : {}),
    };
  }
  const fb = r.firebase as Record<string, unknown> | undefined;
  if (fb && typeof fb === "object" && str(fb.databaseUrl)) {
    config.firebase = { databaseUrl: str(fb.databaseUrl)!, projectId: str(fb.projectId) };
  }
  const ca = r.catalyst as Record<string, unknown> | undefined;
  if (ca && typeof ca === "object") {
    config.catalyst = {
      projectId: str(ca.projectId),
      projectName: str(ca.projectName),
      dc: str(ca.dc) ?? "in",
      appUrl: str(ca.appUrl),
      relayKey: str(ca.relayKey),
      deployedVersion: str(ca.deployedVersion),
    };
  }
  return config;
}

/** Whole file, 0600, moved into place so a crash never leaves half of it. */
export function writeCloudConfig(supportDir: string, config: CloudConfig): void {
  const file = cloudConfigPath(supportDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The relay's base URL from a Catalyst config: the app domain plus the function's route; null until deployed. */
export function relayUrlOf(catalyst: Pick<CatalystConfig, "appUrl"> | null | undefined): string | null {
  return catalyst?.appUrl ? relayBaseUrl(`${catalyst.appUrl.replace(/\/+$/, "")}/server/${RELAY_FUNCTION}`) : null;
}

/** Where Catalyst's web client hosting serves the guest page (cloud/catalyst-relay/client): `<appUrl>/app/index.html` (only index.html answers 200 there). */
export const GUEST_JOIN_PATH = "/app/index.html";

/** The base of a web guest's invite link, from the Catalyst app domain; null until one is deployed. */
export function guestInviteBase(catalyst: Pick<CatalystConfig, "appUrl"> | null | undefined): string | null {
  return catalyst?.appUrl && relayUrlOf(catalyst) ? `${catalyst.appUrl.replace(/\/+$/, "")}${GUEST_JOIN_PATH}` : null;
}

export function catalystLocation(catalyst: CatalystConfig | null | undefined): CloudLocation | null {
  const relayUrl = relayUrlOf(catalyst);
  const key = catalyst?.relayKey;
  return relayUrl && validRelayKey(key) ? { provider: "catalyst", relayUrl, relayKey: key } : null;
}

/** The hosted relay as a location, or null until this Mac holds a usable key. */
export function hostedLocation(hosted: HostedConfig | null | undefined): CloudLocation | null {
  const relayUrl = relayBaseUrl(hosted?.url);
  return relayUrl && validRelayKey(hosted?.macKey)
    ? { provider: "catalyst", relayUrl, relayKey: hosted!.macKey, hosted: true }
    : null;
}

export function firebaseLocation(databaseUrl: string | null | undefined): CloudLocation | null {
  return databaseUrl ? { provider: "firebase", databaseUrl } : null;
}

/**
 * The location the daemon uses: the file's `active` store, with Firebase falling back to `envDatabaseUrl`
 * (`SQUEAK_REMOTE_DATABASE_URL`). A file that says Catalyst with no usable relay falls back to Firebase rather
 * than leaving the phone channel off.
 */
export function activeLocation(config: CloudConfig | null, envDatabaseUrl: string | null): CloudLocation | null {
  if (config?.active === "hosted") {
    const hosted = hostedLocation(config.hosted);
    if (hosted) return hosted;
  }
  if (config?.active === "catalyst") {
    const catalyst = catalystLocation(config.catalyst);
    if (catalyst) return catalyst;
  }
  return firebaseLocation(config?.firebase?.databaseUrl ?? envDatabaseUrl);
}

export interface CloudStoreDeps {
  fetch?: CatalystStoreOptions["fetch"];
  socket?: CatalystStoreOptions["socket"];
  envDatabaseUrl?: string | null;
  /** A hosted store's key was refused (revoked): the daemon goes back to needing sign-in. */
  onUnauthorized?: () => void;
}

/** The store for a location (or for a whole config: its active one). */
export function createCloudStore(from: CloudLocation | CloudConfig, deps: CloudStoreDeps = {}): CloudStore {
  const location: CloudLocation | null = "provider" in from ? from : activeLocation(from, deps.envDatabaseUrl ?? null);
  if (!location) throw new Error("The cloud store is not set up.");
  if (location.provider === "firebase") return new RtdbRest(location.databaseUrl, deps.fetch);
  return new CatalystStore({
    baseUrl: location.relayUrl,
    ...(location.hosted ? { macKey: location.relayKey } : { relayKey: location.relayKey }),
    ...(deps.onUnauthorized && location.hosted ? { onUnauthorized: deps.onUnauthorized } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.socket ? { socket: deps.socket } : {}),
  });
}
