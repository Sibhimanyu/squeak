// Where the app and its relay live. Nothing is hard-coded in code: `scripts/build.mjs` inlines webapp/config/<env>.json as
// `__SQUEAK_CONFIG__`, so a preview or production build differs only by its config file (SQUEAK_WEB_ENV, default development).

export interface AppConfig {
  env: string;
  /** The Slate origin this app is served from; the handoff may only return here. */
  appOrigin: string;
  /** The relay's base URL (no trailing slash): account routes live under it. */
  relayBase: string;
}

declare const __SQUEAK_CONFIG__: AppConfig | undefined;

export function parseConfig(value: unknown): AppConfig {
  const v = (value ?? {}) as Record<string, unknown>;
  const https = (u: unknown): string => {
    const url = new URL(String(u));
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("config: https URLs only");
    return url.href.replace(/\/+$/, "");
  };
  return {
    env: String(v["env"] ?? "development"),
    appOrigin: new URL(https(v["appOrigin"])).origin,
    relayBase: https(v["relayBase"]),
  };
}

export const loadConfig = (): AppConfig =>
  parseConfig(typeof __SQUEAK_CONFIG__ === "undefined" ? undefined : __SQUEAK_CONFIG__);
