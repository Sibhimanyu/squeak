// The invite-link screen of the router skeleton. The Pond and the Duck are in Pond.tsx and Duck.tsx, the Ponds list in Ponds.tsx.

import type { Route } from "../router.js";

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
