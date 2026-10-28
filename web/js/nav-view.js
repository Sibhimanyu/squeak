// The navigation: Home, Needs you and each registered screen (router.js). A bar at
// the foot of the page on every width; it stays while a screen or a chat is open.

import { h } from "./dom.js";

/**
 * @param entries `navEntries()`
 * @param current the id that is open ("home", "needs" or a screen id)
 * @param badges  id -> a count shown on the entry (Needs you)
 * @param onSelect (id) => void
 */
export function navNodes({ entries, current, badges = {}, onSelect, build = h }) {
  return build(
    "nav",
    { class: "tabs", "aria-label": "Squeak" },
    entries.map((entry) => {
      const count = badges[entry.id];
      return build(
        "button",
        {
          class: `tab${entry.id === current ? " on" : ""}${entry.action ? " action" : ""}`,
          type: "button",
          "aria-current": entry.id === current ? "page" : false,
          "data-nav": entry.id,
          onclick: () => onSelect(entry.id),
        },
        entry.icon ? entry.icon() : null,
        build("span", { class: "tab-label" }, entry.title),
        count ? build("span", { class: "tab-badge", "aria-label": `${count} waiting` }, String(count)) : null,
      );
    }),
  );
}
