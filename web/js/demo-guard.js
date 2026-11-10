// The preview mode's one gate. `?demo=1` feeds the page a made-up Mac so the layout can be seen without one (and
// photographed headless by scripts/web-shots.mjs). It is honoured only where the page is served from this machine:
// a file: page, or localhost / 127.0.0.1 / [::1]. On any real host the flag is ignored, so no one can be shown a fake
// Mac, and the paired-state bypass in app.js can never run on the live site.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Whether this page's address allows the preview mode (`location` is `window.location`, or any `{ protocol, hostname, search }`). */
export function demoAllowed(location) {
  if (!location || typeof location !== "object") return false;
  const local = location.protocol === "file:" || LOCAL_HOSTS.has(String(location.hostname ?? "").toLowerCase());
  if (!local) return false;
  return new URLSearchParams(String(location.search ?? "")).get("demo") === "1";
}

/** The preview's own switches, read from the query: which chat or pane is open and which overlay shows. Never trusted beyond these names. */
export function demoOptions(location) {
  const params = new URLSearchParams(String(location?.search ?? ""));
  const word = (name) => (/^[a-z0-9:-]{1,40}$/i.test(params.get(name) ?? "") ? params.get(name) : null);
  return {
    open: word("open"),
    pane: word("pane"),
    palette: params.get("palette") === "1",
    inspector: params.get("inspector") === "1",
    sheet: word("sheet"),
    welcome: word("welcome"),
    query: (params.get("q") ?? "").slice(0, 60),
  };
}
