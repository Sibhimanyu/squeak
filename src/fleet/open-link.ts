/** The page Telegram's "Open in Squeak" button opens: static, on GitHub Pages, published by ios/scripts/release.sh.
 *  It reads `#s=<session id>` (the fragment never reaches a server) and hands off to `squeak://open?s=`. */
export const OPEN_IN_SQUEAK_URL = "https://sibhimanyu.github.io/squeak/open/";

export function openInSqueakLink(sessionId: string): string {
  return `${OPEN_IN_SQUEAK_URL}#s=${encodeURIComponent(sessionId)}`;
}
