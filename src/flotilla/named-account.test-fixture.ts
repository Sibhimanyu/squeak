import type { CloudStore } from "../cloud/store.js";
import type { AccountPort } from "./service.js";

/**
 * Tests for names (docs/ponds.md, "Names"): a person's name has one source, their Squeak account. An owner's Mac learns
 * a joiner's account from the relay (the sign-in behind the request), never from what the joiner's app wrote; `named`
 * is a signed-in account and `verifying` is the relay's part for an in-memory or fake store.
 */
/** Shared by every store in a test: the joiner's Mac and the owner's Mac write and read through different wrappers. */
const seen = new Map<string, { name: string | null; email: string }>();
let lastAttested: { name: string | null; email: string } | null = null;

/** A signed-in account with this name (and email, by default one made from the name), for tests. */
export function named(name: string | null, email?: string | null): AccountPort {
  const mail = email === undefined ? `${(name ?? "someone").toLowerCase().replace(/\W+/g, ".")}@example.test` : email;
  return {
    name: () => name,
    email: () => mail,
    attest: async () => {
      lastAttested = { name, email: mail ?? "" };
      return "test-attest";
    },
    names: async () => ({ names: {} }),
  };
}

/** The relay's note of who signed a join request (`joinids/<requestId>`), for a store that has no relay behind it. */
export function verifying<T extends CloudStore>(store: T): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "set") {
        return async (path: string, doc: unknown, ...rest: unknown[]) => {
          const m = /\/joins\/([^/]+)$/.exec(path);
          if (m && lastAttested) {
            seen.set(m[1]!, lastAttested);
            lastAttested = null;
          }
          return (target.set as (...a: unknown[]) => Promise<void>).call(target, path, doc, ...rest);
        };
      }
      if (prop === "getRaw") {
        return async (path: string) => {
          const m = /\/joinids\/([^/]+)$/.exec(path);
          const who = m ? seen.get(m[1]!) : undefined;
          return who && who.email ? { v: 1, email: who.email, ...(who.name ? { name: who.name } : {}) } : null;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
