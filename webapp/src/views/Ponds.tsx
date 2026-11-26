// The Ponds screen (issue #136): Invitations (Join, Decline), Needs you (questions only; approvals are the Mac's), and the Pond
// list under All · Shared · Not shared, newest first. Every field is drawn as the relay sent it; nothing is worked out here.

import { useState } from "preact/hooks";
import type { Invitation, NeedsYouItem, PondSummary } from "../../../src/shared/shapes.js";
import { age, hueOf, initial } from "../format.js";
import type { Connection } from "../relay/live.js";
import { routePath } from "../router.js";
import type { PondsState } from "../state/ponds-store.js";

export type PondFilter = "all" | "shared" | "not-shared";
const FILTERS: { id: PondFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "shared", label: "Shared" },
  { id: "not-shared", label: "Not shared" },
];

export const FAILED_LIST = "Squeak can't be reached right now.";
export const connectionLine = (c: Connection): string | null =>
  c === "live" ? "Live" : c === "reconnecting" ? "Reconnecting…" : null;

const tint = (key: string): Record<string, string> => ({ "--h": String(hueOf(key)) });

function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span class={`avatar person${small ? " small" : ""}`} style={tint(name)} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

function Tile({ pond }: { pond: { pondId: string; name: string }; owner?: string }) {
  return (
    <span class="avatar tile" style={tint(pond.pondId)} aria-hidden="true">
      {initial(pond.name)}
    </span>
  );
}

function Warning() {
  return (
    <svg class="waiting" viewBox="0 0 24 24" width="22" height="22" role="img" aria-label="Waiting for you">
      <path
        d="M12 3.5 2.8 19.5h18.4L12 3.5Z M12 10v4.5 M12 17.2v.1"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** The working mark: a small pixel tide, still in the markup and animated only in CSS (and not at all under reduced motion). */
function Working() {
  return <span class="tide" role="img" aria-label="Working" />;
}

function InvitationCard(props: {
  invitation: Invitation;
  now: number;
  busy: boolean;
  error: string | undefined;
  onJoin: () => void;
  onDecline: () => void;
}) {
  const { invitation: i } = props;
  return (
    <li class="card invitation" data-invite={i.inviteId}>
      <div class="row">
        <span class="tile-wrap">
          <Tile pond={{ pondId: i.pondName, name: i.pondName }} />
          <Avatar name={i.inviterName} small />
        </span>
        <div class="text">
          <strong>{i.pondName}</strong>
          <span class="sub">
            {i.inviterName} invited you · {age(props.now, i.at, true)}
          </span>
        </div>
      </div>
      <div class="pair">
        <button type="button" class="primary" disabled={props.busy} onClick={props.onJoin}>
          Join
        </button>
        <button type="button" class="outline" disabled={props.busy} onClick={props.onDecline}>
          Decline
        </button>
      </div>
      {props.error ? (
        <p class="failure-line" role="alert">
          {props.error}
        </p>
      ) : null}
    </li>
  );
}

function NeedsYouRow({ item, now }: { item: NeedsYouItem; now: number }) {
  return (
    <li>
      <a class="item" href={`#${routePath({ name: "duck", pondId: item.pondId, duckId: item.duckId })}`}>
        <span class="duck" style={tint(item.duckId)} aria-hidden="true" />
        <span class="text">
          <strong>{item.title}</strong>
          <span class="sub">
            {item.pondName} · {item.duckName} · {age(now, item.at)}
          </span>
        </span>
        <Warning />
      </a>
    </li>
  );
}

function PondRow({ pond, selected, now }: { pond: PondSummary; selected: boolean; now: number }) {
  return (
    <li>
      <a
        class={`item pond${selected ? " selected" : ""}${pond.unread ? " unread" : ""}`}
        href={`#${routePath({ name: "pond", pondId: pond.pondId, tab: "room" })}`}
        aria-current={selected ? "page" : undefined}
      >
        <span class="tile-wrap">
          <Tile pond={pond} />
          {pond.mine ? null : <Avatar name={pond.ownerName} small />}
        </span>
        <span class="text">
          <strong>{pond.name}</strong>
          <span class="sub">{pond.line}</span>
        </span>
        {pond.needsYou ? (
          <Warning />
        ) : pond.working ? (
          <Working />
        ) : (
          <span class="age">{age(now, pond.lastActivityAt)}</span>
        )}
      </a>
    </li>
  );
}

export interface PondsScreenProps {
  account: { name: string; email: string };
  state: PondsState;
  /** The open Pond, to mark its row (wide). */
  selectedPondId: string | null;
  onSignOut: () => void;
  onRetry: () => void;
  onJoin: (inviteId: string) => void;
  onDecline: (inviteId: string) => void;
  now?: number;
}

export function PondsScreen(props: PondsScreenProps) {
  const [filter, setFilter] = useState<PondFilter>("all");
  const { state } = props;
  const now = props.now ?? Date.now();
  const { ponds, invitations, needsYou } = state.overview;
  const shown = ponds.filter((p) => (filter === "all" ? true : filter === "shared" ? p.shared : !p.shared));
  const line = connectionLine(state.connection);

  return (
    <section class="screen" data-screen="ponds">
      <header class="bar">
        <h1>Ponds</h1>
        {state.status === "ready" && line ? (
          <span class="connection" data-connection={state.connection} role="status">
            {line}
          </span>
        ) : null}
        <button
          type="button"
          class="avatar-button"
          onClick={props.onSignOut}
          aria-label={`Sign out ${props.account.name}`}
        >
          {initial(props.account.name)}
        </button>
      </header>
      {state.status === "loading" ? <p class="empty">Loading…</p> : null}
      {state.status === "failed" ? (
        <div class="failure" role="alert">
          <p>{FAILED_LIST}</p>
          <button type="button" class="button" onClick={props.onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <div class="content">
          {invitations.length > 0 ? (
            <section aria-labelledby="h-invitations" data-block="invitations">
              <h2 id="h-invitations">
                Invitations <span class="count">{invitations.length}</span>
              </h2>
              <ul class="cards">
                {invitations.map((i) => (
                  <InvitationCard
                    key={i.inviteId}
                    invitation={i}
                    now={now}
                    busy={state.busy.includes(i.inviteId)}
                    error={state.errors[i.inviteId]}
                    onJoin={() => props.onJoin(i.inviteId)}
                    onDecline={() => props.onDecline(i.inviteId)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {needsYou.length > 0 ? (
            <section aria-labelledby="h-needs" data-block="needs-you">
              <h2 id="h-needs">
                Needs you <span class="count">{needsYou.length}</span>
              </h2>
              <ul class="card list-card">
                {needsYou.map((item) => (
                  <NeedsYouRow key={item.id} item={item} now={now} />
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="h-ponds" data-block="ponds">
            <h2 id="h-ponds">Ponds</h2>
            <div class="segmented" role="tablist" aria-label="Show">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {shown.length > 0 ? (
              <ul class="card list-card">
                {shown.map((p) => (
                  <PondRow key={p.pondId} pond={p} now={now} selected={p.pondId === props.selectedPondId} />
                ))}
              </ul>
            ) : (
              <p class="empty" data-empty={filter}>
                {ponds.length === 0
                  ? "No Ponds yet."
                  : filter === "shared"
                    ? "No shared Ponds."
                    : filter === "not-shared"
                      ? "Every Pond is shared."
                      : "No Ponds yet."}
              </p>
            )}
          </section>
        </div>
      ) : null}
      <footer class="account">
        <Avatar name={props.account.name} />
        <span class="text">
          <strong>{props.account.name}</strong>
          <span class="sub">{props.account.email}</span>
        </span>
        <button type="button" class="link" onClick={props.onSignOut}>
          Sign out
        </button>
      </footer>
    </section>
  );
}
