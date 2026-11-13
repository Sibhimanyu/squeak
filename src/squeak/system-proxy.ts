import { execFileSync } from "node:child_process";

import { logger } from "../utils/logger.js";

/**
 * macOS's System Settings proxy, for the processes launchd starts. A launch agent has no *_PROXY env, so on a Mac that
 * reaches the internet only through a proxy the `claude` CLI went direct and Cloudflare answered 403. Shared by the
 * daemon and the session host: agent children get the env (`withSystemProxyEnv`), and `startSystemProxy` keeps
 * `process.env` and the in-process fetch dispatcher in step with it. PAC and SOCKS are not supported (env left alone).
 */

export interface SystemProxy {
  http?: { host: string; port: number };
  https?: { host: string; port: number };
  exceptions: string[];
  excludeSimpleHostnames: boolean;
  /** A proxy auto-config script is on: Squeak cannot evaluate it, so it leaves the environment alone. */
  pac: boolean;
}

const OFF: SystemProxy = { exceptions: [], excludeSimpleHostnames: false, pac: false };

function endpoint(map: Map<string, string>, prefix: "HTTP" | "HTTPS"): { host: string; port: number } | undefined {
  if (map.get(`${prefix}Enable`) !== "1") return undefined;
  const host = map.get(`${prefix}Proxy`);
  const port = Number.parseInt(map.get(`${prefix}Port`) ?? "", 10);
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    return undefined;
  return { host, port };
}

/** Parses `scutil --proxy` output. Never throws. */
export function parseScutilProxy(text: string): SystemProxy {
  try {
    const map = new Map<string, string>();
    const exceptions: string[] = [];
    let inList = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (inList) {
        if (line === "}") {
          inList = false;
          continue;
        }
        const item = /^\d+\s*:\s*(.+)$/.exec(line);
        if (item?.[1]) exceptions.push(item[1].trim());
        continue;
      }
      if (/^ExceptionsList\s*:\s*<array>\s*\{/.test(line)) {
        inList = true;
        continue;
      }
      const kv = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
      if (kv?.[1]) map.set(kv[1], (kv[2] ?? "").trim());
    }
    const proxy: SystemProxy = {
      exceptions,
      excludeSimpleHostnames: map.get("ExcludeSimpleHostnames") === "1",
      pac: map.get("ProxyAutoConfigEnable") === "1",
    };
    const http = endpoint(map, "HTTP");
    const https = endpoint(map, "HTTPS");
    if (http) proxy.http = http;
    if (https) proxy.https = https;
    return proxy;
  } catch {
    return { ...OFF };
  }
}

const url = (e: { host: string; port: number }): string => `http://${e.host}:${e.port}`;

/** What the merge would add to an environment; empty when nothing applies. */
export function proxyEnvFor(proxy: SystemProxy): Record<string, string> {
  if (proxy.pac) return {};
  const upstream = proxy.https ?? proxy.http;
  if (!upstream) return {};
  const out: Record<string, string> = { HTTPS_PROXY: url(upstream), https_proxy: url(upstream) };
  const plain = proxy.http ?? proxy.https;
  if (plain) {
    out.HTTP_PROXY = url(plain);
    out.http_proxy = url(plain);
  }
  const bypass = [...proxy.exceptions.map((e) => e.replace(/^\*\./, ".")), "127.0.0.1", "localhost", "::1"];
  if (proxy.excludeSimpleHostnames) bypass.push(".local");
  out.NO_PROXY = [...new Set(bypass)].join(",");
  out.no_proxy = out.NO_PROXY;
  return out;
}

/** Merges the proxy into an env: an HTTPS_PROXY already there wins and nothing is added. Pure. */
export function mergeProxyEnv(env: NodeJS.ProcessEnv, proxy: SystemProxy): NodeJS.ProcessEnv {
  if (env.HTTPS_PROXY || env.https_proxy) return env;
  const add = proxyEnvFor(proxy);
  if (Object.keys(add).length === 0) return env;
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(add)) {
    if (key.toLowerCase() === "no_proxy" && merged[key]) merged[key] = `${merged[key]},${value}`;
    else merged[key] ??= value;
  }
  return merged;
}

export type ScutilRead = () => string;

const readScutil: ScutilRead = () =>
  execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });

const CACHE_MS = 30_000;
let cache: { at: number; proxy: SystemProxy } | null = null;
let pacLogged = false;

/** The current system proxy, cached ~30 s, so a changed network is seen without a restart. Never throws. */
export function currentSystemProxy(read: ScutilRead = readScutil, now = Date.now()): SystemProxy {
  if (cache && now - cache.at < CACHE_MS) return cache.proxy;
  let proxy: SystemProxy;
  if (process.platform !== "darwin" && read === readScutil) proxy = { ...OFF };
  else {
    try {
      proxy = parseScutilProxy(read());
    } catch {
      proxy = { ...OFF };
    }
  }
  if (proxy.pac && !pacLogged) {
    pacLogged = true;
    logger.warn("system proxy uses a PAC script; Squeak does not support PAC, so no proxy is set for agents");
  }
  cache = { at: now, proxy };
  return proxy;
}

/** The env for a child that talks to the network (claude, codex, gh, git): computed per spawn, existing proxy env wins. */
export function withSystemProxyEnv(env: NodeJS.ProcessEnv = process.env, read?: ScutilRead): NodeJS.ProcessEnv {
  try {
    return mergeProxyEnv(env, currentSystemProxy(read));
  } catch {
    return env;
  }
}

export function resetSystemProxyCache(): void {
  cache = null;
  pacLogged = false;
}

const OWNED_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;
let owned: Record<string, string> = {};

/**
 * Brings `process.env` in line with the system proxy: values this helper set earlier are replaced or removed when
 * the network changes; a proxy the launcher or the user put there is never touched. Returns whether env changed.
 */
export function applySystemProxyToProcess(env: NodeJS.ProcessEnv = process.env, read?: ScutilRead): boolean {
  const ours = (key: string): boolean => owned[key] !== undefined && env[key] === owned[key];
  let base: NodeJS.ProcessEnv = { ...env };
  for (const key of OWNED_KEYS) if (ours(key)) delete base[key];
  base = mergeProxyEnv(base, currentSystemProxy(read));
  let changed = false;
  const next: Record<string, string> = {};
  for (const key of OWNED_KEYS) {
    const wanted = base[key];
    const had = env[key];
    if (wanted === had) {
      if (ours(key) && had !== undefined) next[key] = had;
      continue;
    }
    if (wanted === undefined) delete env[key];
    else {
      env[key] = wanted;
      next[key] = wanted;
    }
    changed = true;
  }
  owned = next;
  return changed;
}

type FetchHooks = { install: (proxyUrl: string | null, noProxy: string) => Promise<void> };

let timer: NodeJS.Timeout | null = null;

/**
 * Daemon and host startup: apply the proxy to `process.env` now and every 30 s, and point Node's fetch at it (Node's
 * built-in fetch reads proxy env only with NODE_USE_ENV_PROXY=1 at process start, which a launch agent lacks).
 */
export function startSystemProxy(hooks: FetchHooks = { install: installFetchProxy }): void {
  if (timer) return;
  let lastKey = "";
  const tick = (): void => {
    try {
      applySystemProxyToProcess();
      const url = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
      const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
      const key = `${url ?? ""}|${noProxy}`;
      if (key !== lastKey) {
        lastKey = key;
        if (url) logger.info("system proxy in use", { proxy: url });
        void hooks.install(url, noProxy).catch(() => undefined);
      }
    } catch {
      // never break startup over a proxy
    }
  };
  tick();
  timer = setInterval(tick, CACHE_MS);
  timer.unref();
}

export function stopSystemProxy(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function installFetchProxy(proxyUrl: string | null, noProxy: string): Promise<void> {
  const undici = await import("undici");
  if (!proxyUrl) {
    undici.setGlobalDispatcher(new undici.Agent());
    return;
  }
  undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy }));
}
