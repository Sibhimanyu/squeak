// A small hash router. Slate's static hosting ignores redirect rules (a path it has no file for is a 404), so every in-app
// address lives after the `#`: `#/ponds/<id>/ducks/<duck>` survives a reload on any path Slate serves. The router is pure
// (parse, format, parent); `createRouter` is the only part that touches the window.

export type Route =
  | { name: "ponds" }
  | { name: "pond"; pondId: string; tab: "room" | "ducks" }
  | { name: "duck"; pondId: string; duckId: string }
  | { name: "invite"; code: string };

const ID = /^[A-Za-z0-9_~.-]{1,100}$/;

/** `/ponds/p1/ducks/d9` to a route; anything unknown is the Pond list (never a blank screen). */
export function parsePath(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  const [a, b, c, d] = parts;
  if ((a === "invite" || a === "join") && b && ID.test(b) && parts.length === 2) return { name: "invite", code: b };
  if (a === "ponds" && b && ID.test(b)) {
    if (parts.length === 2 || (parts.length === 3 && c === "room")) return { name: "pond", pondId: b, tab: "room" };
    if (parts.length === 3 && c === "ducks") return { name: "pond", pondId: b, tab: "ducks" };
    if (parts.length === 4 && c === "ducks" && d && ID.test(d)) return { name: "duck", pondId: b, duckId: d };
  }
  return { name: "ponds" };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "ponds":
      return "/ponds";
    case "pond":
      return `/ponds/${route.pondId}/${route.tab}`;
    case "duck":
      return `/ponds/${route.pondId}/ducks/${route.duckId}`;
    case "invite":
      return `/invite/${route.code}`;
  }
}

/** Where Back goes: Duck to its Pond's Ducks tab, Pond to the list; the list and an invite have no parent. */
export function parentRoute(route: Route): Route | null {
  if (route.name === "duck") return { name: "pond", pondId: route.pondId, tab: "ducks" };
  if (route.name === "pond") return { name: "ponds" };
  return null;
}

export const hashToPath = (hash: string): string => (hash.startsWith("#/") ? hash.slice(1) : "/ponds");

export interface Router {
  current(): Route;
  go(route: Route, options?: { replace?: boolean }): void;
  subscribe(listener: (route: Route) => void): () => void;
}

export interface RouterWindow {
  location: { hash: string; pathname: string; search: string };
  history: {
    pushState(state: unknown, title: string, url: string): void;
    replaceState(state: unknown, title: string, url: string): void;
  };
  addEventListener(type: "hashchange" | "popstate", listener: () => void): void;
  removeEventListener(type: "hashchange" | "popstate", listener: () => void): void;
}

export function createRouter(win: RouterWindow): Router {
  const listeners = new Set<(route: Route) => void>();
  const current = (): Route => parsePath(hashToPath(win.location.hash));
  const notify = (): void => listeners.forEach((l) => l(current()));
  return {
    current,
    go(route, options = {}) {
      const url = `${win.location.pathname}${win.location.search}#${routePath(route)}`;
      if (options.replace) win.history.replaceState(null, "", url);
      else win.history.pushState(null, "", url);
      notify();
    },
    subscribe(listener) {
      if (listeners.size === 0) {
        win.addEventListener("hashchange", notify);
        win.addEventListener("popstate", notify);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          win.removeEventListener("hashchange", notify);
          win.removeEventListener("popstate", notify);
        }
      };
    },
  };
}
