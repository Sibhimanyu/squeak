// The old-Mac refusal (#133, docs/spec.md "People and remote", Removed paths). The Mac daemon sends `x-squeak-client: mac/<version>` on
// every relay call. A Mac below the version this release ships, or an old Mac that sends no header but proves itself with a
// Mac key, is refused on the Pond routes with 426 and one sentence the Mac shows as it is. Everything else is exempt: the
// iPhone app and the voice add-on (a grant's key under `x-squeak-relay`, no client header, phone-channel kinds only), the web
// (an account token, no client header) and every route that is not a Pond's. The relay's rules for those are unchanged.

/** The version this release ships: Macs below it are refused on Pond routes. SQUEAK_MIN_MAC_VERSION overrides it; "off" turns the gate off. */
const DEFAULT_MIN_MAC_VERSION = "2.35.0";
const UPDATE_MESSAGE = "Update Squeak to keep using shared Ponds";
const CLIENT_HEADER = "x-squeak-client";

/** The kinds that belong to Ponds. Every other kind in kinds.json is the iPhone's or the voice add-on's channel (docs/cloud-layer.md). */
const POND_KINDS = new Set([
  "pond",
  "members",
  "joins",
  "threads",
  "tevents",
  "holds",
  "tcmds",
  "keys",
  "room",
  "rposts",
  "rtasks",
  "roomnote",
]);

/** "mac/2.34.8" -> { kind: "mac", version: [2, 34, 8] }; a version that is not dotted numbers (a dev build) has none. */
function parseClient(value) {
  if (typeof value !== "string") return null;
  const m = /^([a-z][a-z0-9-]{0,15})\/([A-Za-z0-9._+-]{1,40})$/.exec(value.trim());
  if (!m) return null;
  const parts = /^(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?:[-+].*)?$/.exec(m[2]);
  return { kind: m[1], version: parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3] || 0)] : null };
}

function below(version, min) {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] < min[i];
  }
  return false;
}

/** Whether `route` (with its query) is one only a Pond uses. */
function isPondRoute(route, url) {
  if (/^\/ponds(\/|$)/.test(route)) return true;
  if (route === "/invites" || route.startsWith("/invites/")) return true;
  if (route === "/account/ponds" || route === "/account/pond-leaves" || route === "/account/pond-devices") return true;
  if (route.startsWith("/account/invitations/")) return true;
  if (route === "/changes" || route === "/blob" || route === "/live" || route.startsWith("/live/")) return true;
  if (route === "/typing" || route === "/presence") return true;
  if (route === "/doc" || route === "/list") {
    const path = (route === "/doc" ? url.searchParams.get("path") : url.searchParams.get("prefix")) || "";
    const kind = path.split("/")[2];
    return path.startsWith("channels/") && POND_KINDS.has(kind);
  }
  return false;
}

/**
 * `gate(req, route, url)` is true when this request must be refused. `min` is "2.35.0"-style text, or "off".
 * An old Mac is a request that says mac/<below min>, or that says nothing and sends a Mac's own key (`x-squeak-mac-key`: only
 * the Mac daemon sends it; a phone's grant travels as `x-squeak-relay`). A version that is not numbers (a dev build) passes.
 */
function createClientGate(min) {
  const text = String(min === undefined || min === "" ? DEFAULT_MIN_MAC_VERSION : min).trim();
  if (text === "off") return () => false;
  const need = parseClient(`mac/${text}`)?.version ?? parseClient(`mac/${DEFAULT_MIN_MAC_VERSION}`).version;
  return function refuses(req, route, url) {
    if (!isPondRoute(route, url)) return false;
    const header = req.headers[CLIENT_HEADER];
    if (header === undefined) return req.headers["x-squeak-mac-key"] !== undefined;
    const client = parseClient(Array.isArray(header) ? header[0] : header);
    if (!client || client.kind !== "mac" || !client.version) return false;
    return below(client.version, need);
  };
}

module.exports = {
  createClientGate,
  isPondRoute,
  parseClient,
  CLIENT_HEADER,
  DEFAULT_MIN_MAC_VERSION,
  UPDATE_MESSAGE,
  POND_KINDS,
};
