import type { KeyValueStore } from "../src/auth/session.js";
import type { AppConfig } from "../src/config.js";

export const CONFIG: AppConfig = {
  env: "test",
  appOrigin: "https://app.example.test",
  relayBase: "https://relay.example.test/server/squeak_relay",
  liveBase: "https://live.example.test",
};

export const memoryStore = (initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

/** A token in the shape the relay's handoff writes. */
export const TOKEN = "at.u1.1900000000000.abcdefghij.ABCDEFGHIJKLMNOPQRSTUV";
export const FAR_FUTURE = 4_102_444_800_000;
export const storedToken = (exp = FAR_FUTURE): Record<string, string> => ({
  "squeak-account-token": JSON.stringify({ token: TOKEN, exp }),
});
export const ASHA = { userId: "u1", name: "Asha", email: "asha@fernlabs.dev" };
