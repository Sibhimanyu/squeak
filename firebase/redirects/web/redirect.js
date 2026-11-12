// squeak-mac.web.app only forwards now. A link with a fragment (a pairing code or an invite) goes on at once with the
// fragment kept (it never reaches this server); a bare visit shows the notice and a button.
(function () {
  var target = "https://squeak-60083782173.development.catalystserverless.in/app/index.html";
  var hash = location.hash || "";
  document.getElementById("go").href = target + hash;
  if (hash.length > 1) location.replace(target + hash);
})();
