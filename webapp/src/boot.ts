// Makes the address ready before the app draws: takes a handoff token out of it, turns an emailed invite link
// (`/join#<code>`) into the in-app route, and restores where the person was before hosted login.

import { takeHandoffToken, takeReturn, type KeyValueStore } from "./auth/session.js";
import { hashToPath, parsePath, routePath, type Route } from "./router.js";

export interface BootWindow {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(state: unknown, title: string, url: string): void };
}

export function prepareAddress(win: BootWindow, storage: KeyValueStore): Route {
  const { pathname, search, hash } = win.location;
  let target: string | null = null;

  if (takeHandoffToken(hash, storage)) {
    // Back from hosted login: the token is kept, the address is cleaned, and the person returns to where they were.
    target = takeReturn(storage) ?? "/ponds";
  } else if (pathname.replace(/\/+$/, "") === "/join" && hash.length > 1) {
    // An emailed invite link: the code rides in the fragment so it never reaches a server log.
    const route = parsePath(`/join/${hash.slice(1)}`);
    target = route.name === "join" ? routePath(route) : "/ponds";
  }
  if (target === null) return parsePath(hashToPath(hash));
  win.history.replaceState(null, "", `/${search}#${target}`);
  return parsePath(target);
}
