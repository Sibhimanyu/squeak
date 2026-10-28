// The Settings screen's sections. Each work package adds its own with one call
// from a module that is imported (through screens.js) before Settings opens:
//
//   registerSettingsSection({ id: "mac-controls", order: 40, render: (ctx) => Node | Node[] | null })
//
// `order` sorts ascending (built-in: "thinking" 10, "device" 90). `render` gets the screen context (router.js)
// and returns what to draw, or null to leave the section out (a Mac that does not offer it). One that throws
// is skipped and the rest still draw.

const ID = /^[a-z][a-z0-9-]*$/;
const sections = new Map();

export function registerSettingsSection({ id, order = 50, title = null, render }) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error(`bad settings section id: ${String(id)}`);
  if (sections.has(id)) throw new Error(`settings section already registered: ${id}`);
  if (typeof render !== "function") throw new Error(`settings section ${id} needs render()`);
  if (!Number.isFinite(order)) throw new Error(`settings section ${id}: order is a number`);
  sections.set(id, Object.freeze({ id, order, title, render }));
}

export function settingsSections() {
  return [...sections.values()].sort((a, b) => a.order - b.order);
}

export const hasSettingsSection = (id) => sections.has(id);

/** For tests. */
export function resetSettingsSections() {
  sections.clear();
}
