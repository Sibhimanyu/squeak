// The one page that forwards to Squeak for Web (#133). It is served twice from this folder: by Catalyst client hosting at
// `<relay origin>/app/index.html` (client-package.json), and by Firebase Hosting on squeak-mac.web.app for every path
// (`/`, `/join`, `/join/x`; firebase/deploy-redirects.sh copies it). Nothing here is the app: both land on https://squeak.onslate.in.
//
// An invite link keeps its code: `?code=<id>`, `#code=<id>`, `#<id>` (the older `/join#<id>`) or `/join/<id>` all become
// `/invite?code=<id>`, the address the emailed invite uses. Anything else goes to the app's front door with its query and
// fragment unchanged (a sign-in hand-back or a photo result still finds its page).
(function (root) {
  var TARGET = "https://squeak.onslate.in";
  var CODE = /^[A-Za-z0-9_-]{1,200}$/;

  function codeOf(loc) {
    var query = new URLSearchParams(loc.search || "").get("code");
    if (query && CODE.test(query)) return query;
    var hash = (loc.hash || "").replace(/^#/, "");
    var named = /^code=([A-Za-z0-9_-]{1,200})$/.exec(hash);
    if (named) return named[1];
    if (CODE.test(hash)) return hash;
    var path = /^\/join\/([A-Za-z0-9_-]{1,200})\/?$/.exec(loc.pathname || "");
    return path ? path[1] : null;
  }

  function forwardUrl(loc) {
    var code = codeOf(loc);
    if (code) return TARGET + "/invite?code=" + encodeURIComponent(code);
    return TARGET + "/" + (loc.search || "") + (loc.hash || "");
  }

  root.squeakRedirect = { forwardUrl: forwardUrl, TARGET: TARGET };
  if (typeof document === "undefined") return;
  var url = forwardUrl(root.location);
  var go = document.getElementById("go");
  if (go) go.href = url;
  root.location.replace(url);
})(typeof globalThis !== "undefined" ? globalThis : this);
