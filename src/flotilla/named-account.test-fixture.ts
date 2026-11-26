import type { AccountPort } from "./service.js";

/**
 * Tests for names (docs/ponds.md, "Names"): a person's name has one source, their Squeak account. `named` is a signed-in
 * account.
 */

/** A signed-in account with this name (and email, by default one made from the name), for tests. */
export function named(name: string | null, email?: string | null): AccountPort {
  const mail = email === undefined ? `${(name ?? "someone").toLowerCase().replace(/\W+/g, ".")}@example.test` : email;
  return {
    name: () => name,
    email: () => mail,
    names: async () => ({ names: {} }),
  };
}
