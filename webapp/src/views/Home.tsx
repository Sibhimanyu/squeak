// The main area when no Pond is open: for an account with no shared Ponds, a kind first message from Squeak in an empty chat;
// otherwise a quiet "Pick a Pond".

import type { PondsState } from "../state/ponds-store.js";

export interface HomeProps {
  state: PondsState;
  account: { name: string; email: string };
  /** Offer Squeak for Mac (only on a Mac). */
  macHref: string | null;
}

export function Home({ state, account, macHref }: HomeProps) {
  const empty = state.overview.ponds.length === 0;
  return (
    <section class="screen home" data-screen="home">
      <header class="hd">
        <div class="titles">
          <h1>Ponds</h1>
          <span class="subtitle">{account.email}</span>
        </div>
      </header>
      {state.status !== "ready" ? null : empty ? (
        <div class="welcome" data-state="no-ponds">
          <div class="m">
            <img class="mav" src="brand/squeak-duck-full-color.svg" alt="" width="38" height="34" />
            <div class="mb">
              <div class="mh">
                <b>Squeak</b>
              </div>
              <p class="hello">
                <b>Ponds you share from your Mac appear here.</b> When someone invites you to theirs, it shows up here
                too, and you can chat in it straight away.
              </p>
            </div>
          </div>
          <p class="aside">Just shared one? It can take a minute to appear.</p>
          {macHref ? (
            <a class="get-mac" href={macHref}>
              Get Squeak for Mac
            </a>
          ) : null}
        </div>
      ) : (
        <p class="empty pick">Pick a Pond.</p>
      )}
    </section>
  );
}
