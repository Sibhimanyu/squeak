// Makes the address ready before the app draws: takes a handoff token out of it, turns an emailed invite link
// (`/invite?code=<id>`) into the in-app route, and restores where the person was before hosted login.

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
  } else if (pathname.replace(/\/+$/, "") === "/invite") {
    // The emailed invite link: `/invite?code=<invite id>`. The id is an unguessable record key; it is kept in the address
    // only until the page has turned it into the in-app route.
    const code = new URLSearchParams(search).get("code") ?? "";
    const route = parsePath(`/invite/${code}`);
    target = route.name === "invite" ? routePath(route) : "/ponds";
  } else if (pathname.replace(/\/+$/, "") === "/join" && hash.length > 1) {
    // The older emailed link (`/join#<code>`).
    const route = parsePath(`/join/${hash.slice(1)}`);
    target = route.name === "invite" ? routePath(route) : "/ponds";
  }
  if (target === null) return parsePath(hashToPath(hash));
  // The invite code lives on as the route, not as a query.
  const keep = pathname.replace(/\/+$/, "") === "/invite" ? "" : search;
  win.history.replaceState(null, "", `/${keep}#${target}`);
  return parsePath(target);
}
