// Just enough DOM for the guest screens to be built and read in node: elements with attributes, children, listeners.
class Node_ {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.classList = {
      toggle: (name, on) => {
        const set = new Set((this.attrs.class ?? "").split(" ").filter(Boolean));
        if (on) set.add(name);
        else set.delete(name);
        this.attrs.class = [...set].join(" ");
      },
    };
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
    if (name === "disabled") this.disabled = true;
  }
  addEventListener(name, fn) {
    (this.listeners[name] ??= []).push(fn);
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  prepend(...nodes) {
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  set textContent(text) {
    this.children = [{ text: String(text) }];
  }
  get textContent() {
    return text(this);
  }
  focus() {}
}

export const text = (node) => (node.text !== undefined ? node.text : (node.children ?? []).map(text).join(" "));
export const all = (node) => [node, ...(node.children ?? []).flatMap((c) => (c.tag ? all(c) : []))];
export const click = (node) => (node.listeners.click ?? []).forEach((fn) => fn({ preventDefault() {} }));

export function installDom() {
  globalThis.document = {
    createElement: (tag) => new Node_(tag),
    createElementNS: (_ns, tag) => new Node_(tag),
    createTextNode: (t) => ({ text: String(t) }),
    scrollingElement: null,
  };
  globalThis.window = { innerHeight: 800, scrollTo() {} };
}
