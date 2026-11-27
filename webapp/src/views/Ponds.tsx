// The Ponds screen (issue #136): Invitations (Join, Decline), Needs you (questions only; approvals are the Mac's), and the Pond
// list, newest first. The relay sends only metadata; the line under a Pond, the marks and Needs
// you were worked out in the browser from the Pond's own documents (`state/ponds-store.ts`).

import { useEffect, useState } from "preact/hooks";
import type { Invitation, PondSummary } from "../../../src/shared/shapes.js";
import { age, initial } from "../format.js";
import type { NeedsYouItem, PondDerived } from "../pond/derive.js";
import type { Connection } from "../relay/live.js";
import { routePath } from "../router.js";
import type { PondsState } from "../state/ponds-store.js";
import { Avatar, Tile, tint, Warning, Working } from "./marks.js";

export const FAILED_LIST = "Squeak can't be reached right now.";
export const connectionLine = (c: Connection): string | null =>
  c === "live" ? "Live" : c === "reconnecting" ? "Reconnecting…" : null;

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

function PondRow(props: { pond: PondSummary; derived: PondDerived | undefined; selected: boolean; now: number }) {
  const { pond, selected, now } = props;
  const d: PondDerived = props.derived ?? {
    line: "",
    working: false,
    needsYou: false,
    unread: false,
    connecting: true,
  };
  return (
    <li>
      <a
        class={`item pond${selected ? " selected" : ""}${d.unread ? " unread" : ""}${d.connecting ? " connecting" : ""}`}
        href={`#${routePath({ name: "pond", pondId: pond.pondId, tab: "room" })}`}
        aria-current={selected ? "page" : undefined}
      >
        <span class="tile-wrap">
          <Tile pond={pond} />
          {pond.mine ? null : <Avatar name={pond.ownerName} small />}
        </span>
        <span class="text">
          <strong>{pond.name}</strong>
          <span class="sub">{d.line}</span>
        </span>
        {d.needsYou ? <Warning /> : d.working ? <Working /> : <span class="age">{age(now, pond.lastActivityAt)}</span>}
      </a>
    </li>
  );
}

export interface PondsScreenProps {
  account: { name: string; email: string };
  state: PondsState;
  /** The open Pond, to mark its row (wide). */
  selectedPondId: string | null;
  onRetry: () => void;
  onJoin: (inviteId: string) => void;
  onDecline: (inviteId: string) => void;
  now?: number;
}

export function PondsScreen(props: PondsScreenProps) {
  const { state } = props;
  const now = props.now ?? Date.now();
  const { ponds, invitations } = state.overview;
  const { needsYou } = state;
  const line = connectionLine(state.connection);
  // The relay may send the email as the name when the account has none; then say it once.
  const hasName = props.account.name.trim() !== "" && props.account.name !== props.account.email;
  const shownName = hasName ? props.account.name : props.account.email;
  const [inviting, setInviting] = useState(false);
  // The invitations flyout closes with Escape, and by itself once the last invitation is answered.
  useEffect(() => {
    if (invitations.length === 0) setInviting(false);
  }, [invitations.length]);
  useEffect(() => {
    if (!inviting) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setInviting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inviting]);

  return (
    <section class="screen rail" data-screen="ponds">
      <a class="rail-logo" href={`#${routePath({ name: "ponds" })}`} aria-label="Squeak, all Ponds">
        <img src="brand/squeak-duck-full-color.svg" alt="" width="44" height="40" />
      </a>
      <header class="bar">
        <h1>Ponds</h1>
        {state.status === "ready" && line ? (
          <span class="connection" data-connection={state.connection} role="status">
            {line}
          </span>
        ) : null}
        <a class="avatar-button" href={`#${routePath({ name: "settings" })}`} aria-label="Settings">
          {initial(props.account.name)}
        </a>
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
            <section aria-labelledby="h-invitations" data-block="invitations" data-open={inviting ? "" : undefined}>
              <h2 id="h-invitations">
                Invitations <span class="count">{invitations.length}</span>
              </h2>
              <button
                type="button"
                class="item rail-invites"
                aria-expanded={inviting}
                aria-controls="invitations-flyout"
                onClick={() => setInviting(!inviting)}
              >
                <span class="tile-wrap">
                  <span class="avatar tile dashed" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect width="20" height="16" x="2" y="4" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                  </span>
                  <span class="cnt" aria-hidden="true">
                    {invitations.length}
                  </span>
                </span>
                <span class="label">Invites</span>
              </button>
              <ul class="cards flyout" id="invitations-flyout">
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
            {ponds.length > 0 ? (
              <ul class="card list-card">
                {ponds.map((p) => (
                  <PondRow
                    key={p.pondId}
                    pond={p}
                    derived={state.derived[p.pondId]}
                    now={now}
                    selected={p.pondId === props.selectedPondId}
                  />
                ))}
              </ul>
            ) : (
              <>
                <span class="rail-empty" aria-hidden="true" />
                <p class="empty">No Ponds yet.</p>
              </>
            )}
          </section>
        </div>
      ) : null}
      <footer class="account">
        <a
          class="acct"
          href={`#${routePath({ name: "settings" })}`}
          aria-label={`Settings, signed in as ${props.account.email}`}
        >
          <Avatar name={shownName} />
          <span class="text">
            <strong>{hasName ? props.account.name : props.account.email}</strong>
            {hasName ? <span class="sub">{props.account.email}</span> : null}
          </span>
        </a>
      </footer>
    </section>
  );
}
