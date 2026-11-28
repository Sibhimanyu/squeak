// The People sheet (issue #138), the same screen for every role: each person's name with their email under it, "online" or
// "last seen 2 h ago" as text, and the role; invites below with their states. The Owner invites, changes roles, removes,
// withdraws, resends and invites again; a Member or Viewer sees Leave. Every change shows done only after the cloud confirms:
// the list is read again from the cloud, never patched here. A name is never editable (it is the sign-in's), and a person with no
// name shows as their email.

import { useEffect, useState } from "preact/hooks";
import type { PondSummary } from "../../../src/shared/shapes.js";
import { ago, initial } from "../format.js";
import { firstName } from "../pond/derive.js";
import type { ActResult, PondInvite, PondPeople, PondPerson, Relay } from "../relay/client.js";
import { href } from "./parts.js";
import { tint } from "./marks.js";

export const ONLINE_MS = 5 * 60_000;
export const FAILED_PEOPLE = "Squeak can't be reached right now.";
export const FAILED_CHANGE = "That didn't go through. Try again.";
export const leaveText = (pond: string, owner: string): string =>
  `Leave ${pond}? Your messages stay in the Room under your name. To come back you need a new invite from ${owner}.`;

const ROLE_LABEL = { owner: "Owner", member: "Member", viewer: "Viewer" } as const;

export const shownName = (p: { name: string; email: string }): string => p.name.trim() || p.email;

export function lastSeen(now: number, p: PondPerson): string {
  if (p.lastSeenAt <= 0) return "not seen yet";
  return now - p.lastSeenAt < ONLINE_MS ? "online" : `last seen ${ago(now, p.lastSeenAt)}`;
}

/** "Invited · 3 days ago", "Declined · 2 h ago", "Expired", "Withdrawn · 1 h ago". Joined people are in Members, not here. */
export function inviteLine(now: number, i: PondInvite): string {
  switch (i.state) {
    case "pending":
      return `Invited · ${ago(now, i.createdAt)}`;
    case "declined":
      return `Declined · ${ago(now, i.settledAt)}`;
    case "withdrawn":
      return `Withdrawn · ${ago(now, i.settledAt)}`;
    case "expired":
      return "Expired";
    case "joined":
      return `Joined · ${ago(now, i.settledAt)}`;
  }
}

type Confirm = { kind: "remove"; userId: string } | { kind: "leave" } | { kind: "delete" } | null;

export interface PeopleSheetProps {
  relay: Relay;
  token: string;
  pond: PondSummary;
  /** The signed-in account's id (marks "(you)"). */
  selfUserId: string;
  /** Read again when this changes (the Pond's member count moved). */
  version?: number;
  onClose: () => void;
  /** The cloud confirmed this person is out of the Pond (a leave) or the Pond is gone (a delete). */
  onGone: () => void;
  onSignedOut: () => void;
  now?: number;
}

export function PeopleSheet(props: PeopleSheetProps) {
  const { relay, token, pond } = props;
  const now = props.now ?? Date.now();
  const [load, setLoad] = useState<"loading" | "ready" | "failed" | "gone">("loading");
  const [people, setPeople] = useState<PondPeople | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [typed, setTyped] = useState("");

  const read = async (): Promise<void> => {
    const result = await relay.people(token, pond.pondId);
    if (result.status === "unauthorized") return props.onSignedOut();
    if (result.status === "forbidden") return setLoad("gone");
    if (result.status === "unreachable") return setLoad((l) => (l === "ready" ? l : "failed"));
    setPeople(result.people);
    setLoad("ready");
  };
  useEffect(() => {
    void read();
    // the sheet reads again when the Pond's people changed elsewhere
  }, [pond.pondId, props.version]);

  /** Runs one change; the list is read again only when the cloud said it is done. */
  const change = async (key: string, run: () => Promise<ActResult>, after?: () => void): Promise<boolean> => {
    setBusy(key);
    setError(null);
    const result = await run();
    setBusy(null);
    if (result.status === "unauthorized") {
      props.onSignedOut();
      return false;
    }
    if (result.status === "failed") {
      setError(result.message ?? FAILED_CHANGE);
      return false;
    }
    setConfirm(null);
    if (after) after();
    else await read();
    return true;
  };

  const owner = people?.members.find((m) => m.role === "owner");
  const ownerFirst = firstName(owner ? shownName(owner) : pond.ownerName);
  const isOwner = pond.role === "owner";
  const pending = people?.invites.filter((i) => i.state === "pending").length ?? 0;
  const invites = (people?.invites ?? []).filter((i) => i.state !== "joined");
  const countLine = people
    ? isOwner
      ? `${people.members.length + pending} of ${people.cap}, counting invites`
      : `${people.members.length} ${people.members.length === 1 ? "person" : "people"}`
    : "";

  const invite = async (e: Event): Promise<void> => {
    e.preventDefault();
    const address = email.trim();
    if (!address || busy) return;
    const ok = await change("invite", () => relay.invite(token, pond.pondId, [address], role));
    if (ok) setEmail("");
  };

  return (
    <div class="sheet-backdrop" data-sheet="people">
      <section class="sheet" role="dialog" aria-modal="true" aria-label="People" data-role={pond.role}>
        <div class="grab" aria-hidden="true" />
        <header class="sheet-head">
          <div>
            <h2>People</h2>
            <span class="sub" data-count="">
              {countLine}
            </span>
          </div>
          <a class="link done" href={href({ name: "pond", pondId: pond.pondId, tab: "room" })} onClick={props.onClose}>
            Done
          </a>
        </header>
        {load === "loading" ? <p class="empty">Loading…</p> : null}
        {load === "failed" ? (
          <div class="failure" role="alert">
            <p>{FAILED_PEOPLE}</p>
            <button type="button" class="button" onClick={() => void read()}>
              Try again
            </button>
          </div>
        ) : null}
        {load === "gone" ? (
          <p class="banner" role="alert">
            You are no longer in this Pond.
          </p>
        ) : null}
        {load === "ready" && people ? (
          <>
            {isOwner ? (
              <form class="invite-form" onSubmit={(e) => void invite(e)}>
                <input
                  type="email"
                  aria-label="Email address"
                  placeholder="Email address"
                  value={email}
                  onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                />
                <select
                  aria-label="Role for the invite"
                  value={role}
                  onChange={(e) => setRole((e.target as HTMLSelectElement).value as "member" | "viewer")}
                >
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button type="submit" class="primary" disabled={busy !== null || !email.trim()}>
                  Invite
                </button>
              </form>
            ) : null}
            {error ? (
              <p class="failure-line" role="alert" data-error="">
                {error}
              </p>
            ) : null}
            <h3>Members</h3>
            <ul class="card list-card" data-block="members">
              {people.members.map((m) => {
                const self = m.userId === props.selfUserId;
                const name = shownName(m);
                return (
                  <li key={m.userId} class="person-row" data-member={m.userId} data-role={m.role}>
                    <span class="avatar person" style={tint(name)} aria-hidden="true">
                      {initial(name)}
                    </span>
                    <span class="text">
                      <strong>
                        {name}
                        {self ? <span class="you"> (you)</span> : null}
                      </strong>
                      {m.name.trim() ? <span class="sub email">{m.email}</span> : null}
                      <span class="sub presence">{lastSeen(now, m)}</span>
                    </span>
                    {isOwner && m.role !== "owner" ? (
                      <span class="actions">
                        <select
                          aria-label={`Role of ${name}`}
                          value={m.role}
                          disabled={busy !== null}
                          onChange={(e) => {
                            const next = (e.target as HTMLSelectElement).value as "member" | "viewer";
                            void change(`role:${m.userId}`, () => relay.setRole(token, pond.pondId, m.userId, next));
                          }}
                        >
                          <option value="member">Member</option>
                          <option value="viewer">Viewer</option>
                        </select>
                        <button
                          type="button"
                          class="danger-link"
                          disabled={busy !== null}
                          onClick={() => setConfirm({ kind: "remove", userId: m.userId })}
                        >
                          Remove
                        </button>
                      </span>
                    ) : (
                      <span class="role">{ROLE_LABEL[m.role]}</span>
                    )}
                    {confirm?.kind === "remove" && confirm.userId === m.userId ? (
                      <div class="confirm" role="alertdialog" aria-label={`Remove ${name}`}>
                        <p>
                          Remove {name} from {pond.name}? They lose access on every device.
                        </p>
                        <button
                          type="button"
                          class="danger"
                          disabled={busy !== null}
                          onClick={() =>
                            void change(`remove:${m.userId}`, () => relay.removeMember(token, pond.pondId, m.userId))
                          }
                        >
                          Remove
                        </button>
                        <button type="button" class="outline" onClick={() => setConfirm(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {isOwner && invites.length > 0 ? (
              <>
                <h3>
                  Invites <span class="count">{invites.length}</span>
                </h3>
                <ul class="card list-card" data-block="invites">
                  {invites.map((i) => (
                    <li key={i.inviteId} class="person-row invite-row" data-invite={i.inviteId} data-state={i.state}>
                      <span class="avatar person dashed" aria-hidden="true">
                        {initial(i.email)}
                      </span>
                      <span class="text">
                        <strong>{i.email}</strong>
                        <span class="sub">
                          {inviteLine(now, i)}
                          {" · "}
                          {ROLE_LABEL[i.role]}
                          {i.emailFailed && i.state === "pending" ? " · Email not delivered" : ""}
                        </span>
                        <span class="buttons">
                          {i.state === "pending" ? (
                            <>
                              <button
                                type="button"
                                class="outline"
                                disabled={busy !== null}
                                onClick={() =>
                                  void change(`resend:${i.inviteId}`, () =>
                                    relay.inviteAction(token, pond.pondId, i.inviteId, "resend"),
                                  )
                                }
                              >
                                Resend
                              </button>
                              <button
                                type="button"
                                class="outline danger-text"
                                disabled={busy !== null}
                                onClick={() =>
                                  void change(`withdraw:${i.inviteId}`, () =>
                                    relay.inviteAction(token, pond.pondId, i.inviteId, "withdraw"),
                                  )
                                }
                              >
                                Withdraw
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              class="outline"
                              disabled={busy !== null}
                              onClick={() =>
                                void change(`again:${i.inviteId}`, () =>
                                  relay.inviteAction(token, pond.pondId, i.inviteId, "again"),
                                )
                              }
                            >
                              Invite again
                            </button>
                          )}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {isOwner ? (
              <section class="danger-zone" data-block="delete">
                {confirm?.kind === "delete" ? (
                  <form
                    class="confirm"
                    data-confirm="delete"
                    aria-label={`Delete ${pond.name}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (typed.trim() === pond.name)
                        void change("delete", () => relay.deletePond(token, pond.pondId, typed.trim()), props.onGone);
                    }}
                  >
                    <p>Delete {pond.name} for everyone? Type its name to confirm.</p>
                    <input
                      aria-label="Type the Pond's name"
                      placeholder={pond.name}
                      value={typed}
                      onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
                    />
                    <button type="submit" class="danger" disabled={busy !== null || typed.trim() !== pond.name}>
                      Delete
                    </button>
                    <button type="button" class="outline" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button type="button" class="outline danger-text wide" onClick={() => setConfirm({ kind: "delete" })}>
                    Delete {pond.name}
                  </button>
                )}
              </section>
            ) : (
              <>
                <p class="note" data-only-owner="">
                  Only {ownerFirst} can invite, remove or change roles.
                </p>
                {confirm?.kind === "leave" ? (
                  <div class="confirm" role="alertdialog" aria-label={`Leave ${pond.name}`}>
                    <p>{leaveText(pond.name, ownerFirst)}</p>
                    <button
                      type="button"
                      class="danger"
                      disabled={busy !== null}
                      onClick={() => void change("leave", () => relay.leave(token, pond.pondId), props.onGone)}
                    >
                      Leave
                    </button>
                    <button type="button" class="outline" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" class="outline danger-text wide" onClick={() => setConfirm({ kind: "leave" })}>
                    Leave {pond.name}
                  </button>
                )}
              </>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
