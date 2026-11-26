// Which device the page is on. Only the invite page and its follow-up card care: Squeak for Mac is offered on a Mac and nowhere else.

export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}

/** A Mac, not an iPhone or an iPad (iPadOS says "Macintosh" too, but has a touch screen). */
export function isMac(nav: NavigatorLike): boolean {
  if (!/Macintosh|Mac OS X/.test(nav.userAgent)) return false;
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return false;
  return (nav.maxTouchPoints ?? 0) < 2;
}

/** Squeak's website, which offers the latest release (its release.json is the same file the site's download button reads). */
export const MAC_DOWNLOAD_URL = "https://sibhimanyu.github.io/squeak/";
