// The one-time "Add to your home screen" hint shown after pairing. Pure
// decisions here; app.js draws it and remembers the dismissal in its prefs
// (a flag only, never anything from the channel).

/** Which phone browser this is: "ios", "android" or null (a desktop browser gets no hint). */
export function mobileKind(userAgent, maxTouchPoints = 0) {
  const ua = String(userAgent ?? "");
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  // iPadOS Safari reports itself as a Mac with a touch screen.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/.test(ua)) return "android";
  return null;
}

/**
 * What to show, or null for nothing. `standalone` is already running from the
 * home screen; `dismissed` is the remembered flag; `canInstall` is true once
 * Chrome has handed over a `beforeinstallprompt` event.
 */
export function installHint({ paired, kind, standalone, dismissed, canInstall }) {
  if (!paired || !kind || standalone || dismissed) return null;
  if (kind === "ios")
    return { text: "Add Squeak to your home screen: tap Share, then Add to Home Screen.", install: false };
  if (canInstall) return { text: "Add Squeak to your home screen to open it like an app.", install: true };
  return { text: "Add Squeak to your home screen: tap the ⋮ menu, then Add to Home screen.", install: false };
}

/** Is this page already running as an installed app? */
export function isStandalone(win) {
  if (win.navigator?.standalone === true) return true;
  return win.matchMedia?.("(display-mode: standalone)")?.matches === true;
}

/** The dismissal is a preference in this browser's own database (IndexedDB), not web storage: Forget wipes it. */
export function wasDismissed(prefs) {
  return prefs?.installHintDismissed === true;
}
