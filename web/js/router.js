// Screen routing. A screen is a module that draws one pane of the page; the
// page itself (app.js) knows only Home, the Needs you inbox and whatever is
// registered here. A screen module is loaded the first time it is opened.
//
//   registerScreen({ id, title, icon, load, navPlacement, order })
//     id            "new-chat", "usage", "settings"... (lowercase, digits, dashes; not "home" or "needs")
//     title         the label in the navigation and the screen's heading
//     icon          () => Node (an icons.js glyph), or null
//     load          () => import("./my-view.js"): the module must export `render(ctx)`, which returns a Node,
//                   an array of Nodes or null, and may export `title` (a function of ctx) to retitle itself
//     navPlacement  "tab" (a navigation entry), "action" (an entry drawn as a primary action, like New chat),
//                   or "none" (reachable only by `ctx.navigate(id)`); default "none"
//     order         where it sits among the entries (Home 0 and Needs you 10 come first); defaults by id:
//                   new-chat 30, usage 40, settings 90, anything else 60
//
// `ctx` (built in app.js, `screenContext()`): { view, record, sync, commands, outbox, prefs: { get, save },
// navigate(id), touch(), selectChat(key), settings }.
// Registration files (`<name>-screen.js`) are listed by one import line each in `screens.js`.

const ID = /^[a-z][a-z0-9-]*$/;
const RESERVED = new Set(["home", "needs"]);
const PLACEMENTS = new Set(["tab", "action", "none"]);
const DEFAULT_ORDER = { "new-chat": 30, usage: 40, settings: 90 };

const screens = new Map();
const states = new Map();

export function registerScreen(screen) {
  const { id, title, icon = null, load, navPlacement = "none", order } = screen ?? {};
  if (typeof id !== "string" || !ID.test(id) || RESERVED.has(id)) throw new Error(`bad screen id: ${String(id)}`);
  if (screens.has(id)) throw new Error(`screen already registered: ${id}`);
  if (typeof title !== "string" || title === "") throw new Error(`screen ${id} needs a title`);
  if (typeof load !== "function") throw new Error(`screen ${id} needs load()`);
  if (!PLACEMENTS.has(navPlacement)) throw new Error(`screen ${id}: navPlacement is tab, action or none`);
  if (icon !== null && typeof icon !== "function") throw new Error(`screen ${id}: icon is a function or null`);
  if (order !== undefined && !Number.isFinite(order)) throw new Error(`screen ${id}: order is a number`);
  screens.set(id, Object.freeze({ id, title, icon, load, navPlacement, order: order ?? DEFAULT_ORDER[id] ?? 60 }));
}

export const getScreen = (id) => screens.get(id) ?? null;
export const isScreen = (id) => screens.has(id);

/** Registered screens in navigation order (ties by registration). */
export function screenList() {
  return [...screens.values()].sort((a, b) => a.order - b.order);
}

/**
 * The navigation entries in order: Home, Needs you, then each registered screen placed "tab" or "action".
 * An entry is `{ id, title, kind: "home" | "needs" | "screen", action, icon }`.
 */
export function navEntries() {
  const own = screenList()
    .filter((screen) => screen.navPlacement !== "none")
    .map((screen) => ({
      id: screen.id,
      title: screen.title,
      kind: "screen",
      action: screen.navPlacement === "action",
      icon: screen.icon,
    }));
  return [
    { id: "home", title: "Home", kind: "home", action: false, icon: null },
    { id: "needs", title: "Needs you", kind: "needs", action: false, icon: null },
    ...own,
  ];
}

/** `{ status: "idle" | "loading" | "ready" | "error", module, error }` for a registered screen. */
export function screenState(id) {
  return states.get(id) ?? { status: "idle", module: null, error: null };
}

/** Loads a screen's module once; resolves to its state. A module without `render` is an error, never a blank pane. */
export function loadScreen(id) {
  const screen = screens.get(id);
  if (!screen) return Promise.resolve({ status: "error", module: null, error: new Error(`no screen ${id}`) });
  const current = states.get(id);
  if (current?.status === "ready") return Promise.resolve(current);
  if (current?.promise) return current.promise;
  const promise = (async () => {
    try {
      const module = await screen.load();
      if (typeof module?.render !== "function") throw new Error(`screen ${id} has no render()`);
      const ready = { status: "ready", module, error: null };
      states.set(id, ready);
      return ready;
    } catch (error) {
      // Forget the failure so a later open tries again.
      const failed = { status: "error", module: null, error };
      states.set(id, failed);
      return failed;
    }
  })();
  states.set(id, { status: "loading", module: null, error: null, promise });
  return promise;
}

/** For tests: forget every registration and loaded module. */
export function resetScreens() {
  screens.clear();
  states.clear();
}
