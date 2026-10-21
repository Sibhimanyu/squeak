// Building the page. Everything that came from the channel (an agent's words,
// a title, a path) goes in through createTextNode / textContent and nothing
// else. There is deliberately no helper here that takes HTML.

/** `h("div", { class: "card" }, "text", childNode)`; strings become text nodes. Attributes are fixed names, never agent data. */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
