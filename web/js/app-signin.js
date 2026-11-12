// The page a native Squeak app sends the browser to for an account sign-in (docs/web-app.md, "App sign-in"):
// `#mac-signin=<state>` is Squeak for Mac asking for a link ticket, `#mac-cloud=<state>` is the same Mac asking for an account token to set up Squeak's cloud, `#app-signin=<state>` is the iPhone app asking for an account
// token, and `#photo=<state>` is Squeak for Mac sending the owner here to change their profile photo (picker, then a button
// back to `squeak-mac://photo-updated?state=`). The browser signs in through Catalyst's hosted login (the same way the guest page does), says who it is, and a button,
// never an automatic redirect, hands the result to the app by its own URL scheme, so a page someone else opened cannot
// silently give a token away. The app checks `state` on its side too. Nothing here is logged or stored beyond the parked
// {mode, state, at} in sessionStorage across the login round trip (10 minutes).

import { h } from "./dom.js";
import { AccountApi, SENTENCES } from "./account.js";
import { accountRelayBase, sdkSignOut, signInRedirect } from "./catalyst-session.js";
import { createAvatarController } from "./avatar.js";
import { photoPicker } from "./avatar-view.js";
import { laptopIcon, logInIcon, shieldIcon } from "./icons.js";
import { mountEmbeddedLogin } from "./embedded-login.js";
import { errorPage, signedInScreen, signedOutScreen } from "./signin-view.js";
import { welcomeLayout, wlButton } from "./welcome-view.js";

export const PARKED_KEY = "squeak-app-signin";
export const PARKED_MAX_MS = 10 * 60 * 1000;
const STATE = /^[A-Za-z0-9_-]{16,64}$/;
const MODES = { "mac-signin": "mac", "mac-cloud": "cloud", "app-signin": "app", photo: "photo" };

/** `{ mode, state }` for a sign-in fragment, `{ error: "state" }` when it is one with a bad state, else null. */
export function parseSigninFragment(hash) {
  const m = /^#(mac-signin|mac-cloud|app-signin|photo)=(.*)$/.exec(String(hash ?? ""));
  if (!m) return null;
  // `#mac-signin=<state>&want=ticket,token`: Squeak for Mac asks for both in one pass (the one-step sign-in).
  const [state, ...rest] = m[2].split("&");
  if (!STATE.test(state)) return { error: "state" };
  const both = m[1] === "mac-signin" && rest.length === 1 && rest[0] === "want=ticket,token";
  if (rest.length && !both) return { error: "state" };
  return { mode: MODES[m[1]], state, ...(both ? { both: true } : {}) };
}

/** A parked, whole and young-enough entry, else null. */
export function readParked(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const p = JSON.parse(storage?.getItem(PARKED_KEY) ?? "null");
    if (
      p &&
      (p.mode === "mac" || p.mode === "cloud" || p.mode === "app" || p.mode === "photo") &&
      STATE.test(String(p.state)) &&
      now - p.at >= 0 &&
      now - p.at < PARKED_MAX_MS
    )
      return { mode: p.mode, state: p.state, at: p.at, ...(p.both === true && p.mode === "mac" ? { both: true } : {}) };
  } catch {
    // unreadable: nothing parked
  }
  return null;
}

const park = (storage, entry, now) => {
  try {
    storage.setItem(
      PARKED_KEY,
      JSON.stringify({ mode: entry.mode, state: entry.state, at: now, ...(entry.both ? { both: true } : {}) }),
    );
  } catch {
    // storage refused: the person starts again from the app
  }
};
const unpark = (storage) => {
  try {
    storage.removeItem(PARKED_KEY);
  } catch {
    // nothing to remove
  }
};

const enc = encodeURIComponent;

/** The URL handed to the app: the ticket or token and the state it must recognise. */
export function appUrl(mode, secret, state, user, token) {
  if (mode === "photo") return `squeak-mac://photo-updated?state=${enc(state)}`;
  if (mode === "cloud") return `squeak-mac://signed-in?token=${enc(secret)}&state=${enc(state)}`;
  return mode === "mac"
    ? `squeak-mac://signed-in?ticket=${enc(secret)}${token ? `&token=${enc(token)}` : ""}&state=${enc(state)}`
    : `squeak://signed-in?token=${enc(secret)}&state=${enc(state)}&email=${enc(user.email)}&name=${enc(user.name)}`;
}

const SENTENCE = {
  state: "This link is not complete. Start the sign-in again from Squeak.",
  ...SENTENCES,
};

/** Signed in: the calm "You're in" page (signin-view.js). */
export const signinScreen = ({ user, error, busy, onContinue, onSignOut }) =>
  signedInScreen({ user, error, busy, onContinue, onSignOut });

/** The photo page: the picker, and once something changed, the way back to the app. */
export function photoScreen({ user, photo, changed, onBack }) {
  const who = user?.name ? `${user.name} (${user.email})` : (user?.email ?? "");
  return welcomeLayout({
    invite: { eyebrow: "Photo for", title: "Squeak for Mac", detail: "Choose it here, then come back to the app" },
    points: [
      { icon: shieldIcon, text: "Only a small square copy is kept" },
      { icon: laptopIcon, text: "Your Mac and phone show it too" },
      { icon: logInIcon, text: "One tap takes you back to the app" },
    ],
    children: [
      h("p", { class: "wl-eyebrow" }, "Profile photo"),
      h("h1", null, "Your Squeak photo"),
      h("p", { class: "wl-lead" }, `Signed in as ${who}. A square crop is saved, without the original file's details.`),
      photoPicker({ label: user?.name || user?.email || "", photo, wl: true }),
      changed ? h("div", { class: "wl-actions" }, wlButton("Back to Squeak", onBack, { primary: true })) : null,
    ],
  });
}

export const errorScreen = (error) => errorPage(error);

/** Runs the callback page. `win` supplies location, history, sessionStorage; everything else is replaceable for tests. */
export async function startSignin({
  root,
  win = globalThis,
  storage = win.sessionStorage,
  now = () => Date.now(),
  api = new AccountApi({ baseUrl: accountRelayBase(win.location) ?? "" }),
  signIn = signInRedirect,
  signOut = sdkSignOut,
  mountLogin = (box, report) => mountEmbeddedLogin(box, report, { win }),
} = {}) {
  const mount = (...nodes) => root.replaceChildren(...nodes);
  const fromFragment = parseSigninFragment(win.location?.hash);
  if (win.location?.hash) {
    try {
      win.history.replaceState(null, "", win.location.pathname + win.location.search);
    } catch {
      // no history: the fragment stays, harmlessly
    }
  }
  if (fromFragment?.error) {
    unpark(storage);
    return mount(errorScreen(SENTENCE.state));
  }
  const entry = fromFragment ?? readParked(storage, now());
  if (!entry) {
    unpark(storage);
    return mount(errorScreen(SENTENCE.state));
  }

  const me = await api.me();
  if (me.state === "out") {
    // Parked first: the login (embedded here, or the hosted page) returns to /app/index.html and resumes it.
    park(storage, entry, now());
    return mount(signedOutScreen({ mode: entry.mode, signIn: () => signIn(win), mount: mountLogin }));
  }
  if (me.state !== "in") return mount(errorScreen(SENTENCE.network));

  if (entry.mode === "photo") return startPhoto({ entry, me, api, mount, win, storage });

  const ui = { error: null, busy: false };
  const draw = () =>
    mount(
      signinScreen({
        mode: entry.mode,
        user: me.user,
        error: ui.error,
        busy: ui.busy,
        onContinue: go,
        onSignOut: out,
      }),
    );
  async function go() {
    if (ui.busy) return;
    ui.busy = true;
    ui.error = null;
    draw();
    try {
      if (entry.mode === "mac" && entry.both) {
        // Both come from the one signed-in session, so there is no second prompt. A token that cannot be minted
        // leaves the ticket alone: the Mac then takes its separate "Finish connecting" step.
        const [ticket, account] = await Promise.all([api.linkTicket(), api.appToken().catch(() => null)]);
        unpark(storage);
        win.location.assign(appUrl("mac", ticket, entry.state, me.user, account?.value));
      } else {
        const secret = entry.mode === "mac" ? await api.linkTicket() : await api.appToken();
        unpark(storage);
        win.location.assign(appUrl(entry.mode, secret.value ?? secret, entry.state, secret.user ?? me.user));
      }
    } catch (error) {
      ui.error = error?.status === 401 ? SENTENCE.signin : SENTENCE.network;
    }
    ui.busy = false;
    draw();
  }
  async function out() {
    park(storage, entry, now());
    try {
      await signOut(win);
    } catch {
      ui.error = SENTENCE.network;
      draw();
    }
  }
  draw();
}

/** `#photo=`: the owner is signed in; show the photo picker, and hand "done" back to the app by its own URL. */
async function startPhoto({ entry, me, api, mount, win, storage }) {
  const photo = createAvatarController({ api, onChange: () => draw() });
  const draw = () =>
    mount(
      photoScreen({
        user: me.user,
        photo: {
          url: photo.state.url,
          busy: photo.state.busy,
          error: photo.state.error,
          change: (file) => photo.change(file),
          remove: () => photo.remove(),
        },
        changed: photo.state.changed,
        onBack: () => {
          unpark(storage);
          win.location.assign(appUrl("photo", null, entry.state));
        },
      }),
    );
  draw();
  await photo.load(me.user?.avatarAt ?? 0);
}
