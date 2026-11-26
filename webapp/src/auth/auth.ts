// The sign-in flow as a small state machine, free of the page so a test drives it with a fake relay.
//
//   checking -> signed-out            no kept token (nothing is asked of the network)
//   checking -> signed-in             the relay knows the token
//   checking -> signed-out            the relay says 401: the token is forgotten
//   checking -> failed                anything else: ONE sentence and Try again, never another screen
//   signed-out -> (leaves the page)   Continue with Zoho / Google / email: hosted login, back to where you were

import type { AccountInfo } from "../../../src/shared/shapes.js";
import type { AppConfig } from "../config.js";
import type { Relay } from "../relay/client.js";
import { clearToken, handoffUrl, readToken, saveReturn, type KeyValueStore, type Provider } from "./session.js";

export type AuthState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "signed-in"; account: AccountInfo; token: string }
  | { status: "failed"; message: string };

export const UNREACHABLE_MESSAGE = "Squeak can't be reached right now.";

export interface AuthDeps {
  config: AppConfig;
  relay: Relay;
  storage: KeyValueStore;
  /** Leaves the page for a URL (location.assign). */
  navigate: (url: string) => void;
  now?: () => number;
}

export interface Auth {
  state(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  /** Reads the kept token and asks the relay who it is. Safe to call again: Try again is this. */
  start(): Promise<void>;
  /** Goes to hosted login; `returnPath` (an in-app path) is where the person comes back to. */
  signIn(provider: Provider, returnPath: string): void;
  signOut(): void;
}

export function createAuth(deps: AuthDeps): Auth {
  let current: AuthState = { status: "checking" };
  const listeners = new Set<(state: AuthState) => void>();
  const set = (next: AuthState): void => {
    current = next;
    listeners.forEach((l) => l(next));
  };
  // A second start() while one is in flight must not let the older answer overwrite the newer.
  let run = 0;
  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async start() {
      const mine = ++run;
      const token = readToken(deps.storage, deps.now?.() ?? Date.now());
      if (!token) return set({ status: "signed-out" });
      set({ status: "checking" });
      const result = await deps.relay.me(token);
      if (mine !== run) return;
      if (result.status === "ok") return set({ status: "signed-in", account: result.account, token });
      if (result.status === "unauthorized") {
        clearToken(deps.storage);
        return set({ status: "signed-out" });
      }
      set({ status: "failed", message: UNREACHABLE_MESSAGE });
    },
    signIn(provider, returnPath) {
      saveReturn(deps.storage, returnPath);
      deps.navigate(handoffUrl(deps.config, provider));
    },
    signOut() {
      run++;
      clearToken(deps.storage);
      set({ status: "signed-out" });
    },
  };
}
