// The page replaces its whole DOM on a draw, which would send a scrolled screen back to the top. A screen that
// scrolls itself calls this while building its nodes (the old ones are still on the page) and the scroll
// position is put back as soon as the new ones are in.

/** Remembers `.className`'s scroll position (when it is for the same `key`) and restores it after the draw. */
export function keepScroll(className, key = "") {
  const old = globalThis.document?.querySelector?.(`.${className}`);
  if (!old || old.dataset.key !== key || old.scrollTop <= 0) return;
  const top = old.scrollTop;
  queueMicrotask(() => {
    const now = globalThis.document.querySelector(`.${className}`);
    if (now && now.dataset.key === key) now.scrollTop = top;
  });
}
