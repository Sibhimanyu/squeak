# Squeak for Web

The web app is the rebuild in `webapp/`: see [`web-app-v2.md`](web-app-v2.md) (layout, sign-in, the Ponds screen, the Room and Ducks,
the People sheet, Settings and the connection states) and `docs/spec.md`, "Web app".

The old `web/` client (the paired-phone app and the `guest-*` invite page, about 28,000 lines), the guest-page build
(`scripts/build-guest-client.sh`) and the legacy Slate staging script were deleted in #138. Nothing there is still served: the
Catalyst client folder `cloud/catalyst-relay/client/` keeps only its `client-package.json`, which the `/app/index.html` redirect
(#133) uses: `client/index.html` and `client/redirect.js` forward to `squeak.onslate.in` (an invite code becomes `/invite?code=`);
`squeak-mac.web.app` (every path, `/join` included) serves the same two files (`firebase/deploy-redirects.sh`). Invitations, the People sheet and Leave are the relay's routes (`docs/cloud-layer.md`), drawn by the new app.
