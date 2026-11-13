// squeak-mac.web.app only forwards now. Every path (/, /join, /join/x, ...) lands on the one page Catalyst serves
// (/app/index.html: pairing links and invite links both open there); the query and the fragment (a pairing code or an
// invite, which never reaches this server) are kept. A link with a fragment goes on at once; a bare visit shows the
// notice and a button.
(function (root) {
  var TARGET = "https://squeak-60083782173.development.catalystserverless.in/app/index.html";
  function forwardUrl(loc) {
    return TARGET + (loc.search || "") + (loc.hash || "");
  }
  root.squeakRedirect = { forwardUrl: forwardUrl, TARGET: TARGET };
  if (typeof document === "undefined") return;
  var url = forwardUrl(root.location);
  var go = document.getElementById("go");
  if (go) go.href = url;
  if ((root.location.hash || "").length > 1) root.location.replace(url);
})(typeof globalThis !== "undefined" ? globalThis : this);
