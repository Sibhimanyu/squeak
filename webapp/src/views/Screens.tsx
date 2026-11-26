// Placeholder screens for the router skeleton: a Pond (Room | Ducks), a Duck and an invite link. No data yet (#137 onward).
// The Ponds list is in Ponds.tsx.

import type { Route } from "../router.js";
import { parentRoute, routePath } from "../router.js";

const href = (route: Route): string => `#${routePath(route)}`;

function BackBar({ route, title }: { route: Route; title: string }) {
  const parent = parentRoute(route);
  return (
    <header class="bar">
      {parent ? (
        <a class="back" href={href(parent)} aria-label="Back">
          ‹
        </a>
      ) : null}
      <h1>{title}</h1>
    </header>
  );
}

export function PondScreen({ route }: { route: Extract<Route, { name: "pond" }> }) {
  return (
    <section class="screen" data-screen="pond">
      <BackBar route={route} title="Pond" />
      <nav class="tabs" role="tablist" aria-label="Pond">
        <a role="tab" aria-selected={route.tab === "room"} href={href({ ...route, tab: "room" })}>
          Room
        </a>
        <a role="tab" aria-selected={route.tab === "ducks"} href={href({ ...route, tab: "ducks" })}>
          Ducks
        </a>
      </nav>
      <p class="empty">{route.tab === "room" ? "The Room is empty." : "No Ducks yet."}</p>
    </section>
  );
}

export function DuckScreen({ route }: { route: Extract<Route, { name: "duck" }> }) {
  return (
    <section class="screen" data-screen="duck">
      <BackBar route={route} title="Duck" />
      <p class="empty">Nothing here yet.</p>
    </section>
  );
}

export function JoinScreen({ route }: { route: Extract<Route, { name: "join" }> }) {
  return (
    <section class="screen" data-screen="join">
      <header class="bar">
        <h1>Invitation</h1>
      </header>
      <p class="empty" data-code={route.code}>
        Join and Decline arrive with the invitation screens.
      </p>
    </section>
  );
}
