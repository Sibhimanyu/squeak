// The invite page (issue #132, docs/spec.md "Invited without Squeak: the invite page is the welcome"). The emailed button opens it;
// it is Squeak's first impression, so it sells as well as it lets in. The relay's record decides everything drawn here: the state
// (pending, withdrawn, expired, joined, declined), who invited, who is in the Pond, the masked address. Join and Not for me are the
// relay's two verbs; this page decides nothing about an invite itself.

import { useState } from "preact/hooks";
import type { InvitePreview, InviteState } from "../../../src/shared/shapes.js";
import type { Provider } from "../auth/session.js";
import { initial } from "../format.js";
import { MAC_DOWNLOAD_URL } from "../platform.js";
import type { RespondResult } from "../relay/client.js";
import { Avatar, tint } from "./marks.js";

export type InviteLoad = { status: "loading" } | { status: "missing" } | { status: "ok"; invite: InvitePreview };

export interface InvitePageProps {
  load: InviteLoad;
  /** Signed in as this address (the person's own); null when signed out. */
  signedInAs: string | null;
  isMac: boolean;
  onSignIn: (provider: Provider) => void;
  /** Join or Not for me, answered by the relay. */
  onAnswer: (answer: "join" | "decline") => Promise<RespondResult>;
  /** The person joined: open the Pond. */
  onJoined: (pondId: string | null) => void;
  /** Sign out so another account can sign in. */
  onSwitchAccount: () => void;
}

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "zoho", label: "Continue with Zoho" },
  { id: "google", label: "Continue with Google" },
  { id: "email", label: "Continue with email" },
];
const SETTLED: readonly string[] = ["withdrawn", "expired", "joined", "declined"];

export const expiryShort = (epochMs: number): string =>
  new Date(epochMs).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "Sibhi", "Sibhi and Asha", "Sibhi, Asha and Dev". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The one sentence for an invite that is not pending. */
export function settledLine(state: Exclude<InviteState, "pending">, inviter: string): string {
  switch (state) {
    case "withdrawn":
      return `${inviter} withdrew this invitation.`;
    case "expired":
      return "This invitation expired.";
    case "joined":
      return "You already joined.";
    case "declined":
      return "You declined this invitation.";
  }
}

const Lockup = () => (
  <picture>
    <source srcset="brand/squeak-lockup-horizontal-paper.svg" media="(prefers-color-scheme: dark)" />
    <img class="lockup-h" src="brand/squeak-lockup-horizontal-ink.svg" alt="Squeak" height="30" />
  </picture>
);

function Story({ pond, inviter, members }: { pond: string; inviter: string; members: string[] }) {
  const others = nameList(members.length > 0 ? members : [inviter]);
  return (
    <>
      <p class="story-lede">Squeak is where people and coding agents get work done together.</p>
      <section class="story" aria-label="What Squeak is">
        <article class="part">
          <div class="words">
            <p class="kicker">1 · The Room</p>
            <h2>Talk it through with people and Ducks.</h2>
            <p>
              Everyone working on {pond} shares one Room. {others} write to each other, and the Ducks, Squeak's coding
              agents, report in with a short line when they start, finish or need something.
            </p>
          </div>
          <img class="shot phone" src="assets/invite/room.png" alt="A Room: people and a Duck talking" />
        </article>
        <article class="part flip">
          <div class="words">
            <p class="kicker">2 · Ducks</p>
            <h2>Ask once. A Duck gets on with it.</h2>
            <p>
              Start a Duck on a piece of work and it runs on {inviter}'s Mac. When it needs a decision it stops and asks
              you, with the choices spelled out, instead of guessing.
            </p>
          </div>
          <img class="shot phone" src="assets/invite/duck.png" alt="A Duck asking a question with choices" />
        </article>
        <article class="part">
          <div class="words">
            <p class="kicker">3 · The Pond</p>
            <h2>See the whole project at a glance.</h2>
            <p>
              Each project is a Pond with its own colour. Its Dashboard shows what needs you, which Ducks are working
              and the latest in the Room, so you can pick up where everyone left off.
            </p>
          </div>
          <img class="shot wide" src="assets/invite/pond.png" alt="A Pond's Dashboard" />
        </article>
      </section>
      <p class="member-line">
        <span class="flock" aria-hidden="true">
          {members.slice(0, 3).map((m) => (
            <Avatar key={m} name={m} />
          ))}
        </span>
        <span>
          As a Member of {pond} you can read and post in the Room, start Ducks and answer the questions they ask.{" "}
          {inviter} approves new Tasks and edits.
        </span>
      </p>
    </>
  );
}

export function InvitePage(props: InvitePageProps) {
  const { load } = props;
  const [override, setOverride] = useState<InviteState | null>(null);
  const [choosing, setChoosing] = useState<"join" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"failed" | "full" | "email" | null>(null);

  if (load.status !== "ok") {
    return (
      <main class="invite plain">
        <Lockup />
        <p class="quiet" role="status" data-invite={load.status}>
          {load.status === "loading"
            ? "Opening your invitation…"
            : "We can't find this invitation. Ask whoever invited you to send a new one."}
        </p>
      </main>
    );
  }

  const { invite } = load;
  const state: InviteState = override ?? invite.state;
  const pending = state === "pending";
  const signedIn = props.signedInAs !== null;
  const masked = invite.masked;

  const answer = async (which: "join" | "decline"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await props.onAnswer(which);
    setBusy(false);
    if (result.status === "ok") {
      if (which === "join") props.onJoined(result.pondId);
      else setOverride("declined");
    } else if (result.status === "refused") {
      if (SETTLED.includes(result.why)) setOverride(result.why as InviteState);
      else setProblem(result.why === "email" ? "email" : result.why === "full" ? "full" : "failed");
    } else if (result.status === "failed") setProblem("failed");
  };
  const start = (which: "join" | "decline"): void => {
    if (signedIn) void answer(which);
    else setChoosing(which);
  };

  const mainButtons = (
    <div class="actions">
      <button type="button" class="button solid" disabled={busy} onClick={() => start("join")}>
        {signedIn ? `Join ${invite.pond}` : "Join in your browser"}
      </button>
      {props.isMac ? (
        <a class="button" href={MAC_DOWNLOAD_URL}>
          Get Squeak for Mac
        </a>
      ) : null}
    </div>
  );

  return (
    <main class="invite" style={tint(invite.pond)} data-state={state}>
      <header class="top">
        <Lockup />
        {pending && masked ? <span class="for">An invitation for {masked}</span> : null}
      </header>
      <section class="hero">
        <div class="hero-text">
          <p class="pond-line">
            <span class="avatar tile big" style={tint(invite.pond)} aria-hidden="true">
              {initial(invite.pond)}
            </span>
            <span class="kicker">{invite.pond} · a Pond</span>
          </p>
          {pending ? (
            <h1>
              {invite.inviter} invited you to <span class="pond-name">{invite.pond}</span>
            </h1>
          ) : (
            <h1 class="settled" data-settled={state}>
              {settledLine(state as Exclude<InviteState, "pending">, invite.inviter)}
            </h1>
          )}
          {pending ? (
            <p class="lede">
              A shared place where people and coding Ducks work on the same project, together in one Room.
            </p>
          ) : null}
          {invite.members.length > 0 ? (
            <p class="members">
              <span class="flock" aria-hidden="true">
                {invite.members.slice(0, 4).map((m) => (
                  <Avatar key={m} name={m} />
                ))}
              </span>
              <span>
                {nameList(invite.members)} {invite.members.length === 1 ? "is" : "are"} in {invite.pond}
                {pending ? " and waiting for you" : ""}.
              </span>
            </p>
          ) : null}

          {pending ? (
            <>
              {mainButtons}
              {problem === "email" ? (
                <p class="problem" role="alert" data-problem="email">
                  This invitation is for {masked}. You are signed in with a different address.{" "}
                  <button type="button" class="link" onClick={props.onSwitchAccount}>
                    Switch account
                  </button>
                </p>
              ) : null}
              {problem === "full" ? (
                <p class="problem" role="alert">
                  {invite.pond} is full right now. Ask {invite.inviter} to make room.
                </p>
              ) : null}
              {problem === "failed" ? (
                <p class="problem" role="alert">
                  That didn't work. Try again in a moment.
                </p>
              ) : null}
              <p class="fine">
                Joining takes a sign-up with Zoho, Google or email. Nothing to install.
                {props.isMac && masked ? (
                  <>
                    <br />
                    On the Mac app, sign in with <strong>{masked}</strong> and {invite.pond} will be waiting.
                  </>
                ) : null}
              </p>
              <p class="fine">
                <button type="button" class="link" disabled={busy} onClick={() => start("decline")}>
                  Not for me
                </button>
                {signedIn ? (
                  <>
                    {" · "}
                    <button type="button" class="link" onClick={props.onSwitchAccount}>
                      Switch account
                    </button>
                  </>
                ) : null}
              </p>
            </>
          ) : state === "joined" ? (
            <div class="actions">
              {signedIn ? (
                <a class="button solid" href="#/ponds">
                  Open {invite.pond}
                </a>
              ) : (
                <button type="button" class="button solid" onClick={() => setChoosing("join")}>
                  Sign in to open {invite.pond}
                </button>
              )}
            </div>
          ) : state === "declined" ? null : (
            <p class="ask">Ask {invite.inviter} for a new invitation.</p>
          )}
          {choosing && !signedIn ? (
            <div class="providers" role="group" aria-label="Sign in to continue">
              <p class="quiet">
                {!pending
                  ? "Sign in to continue."
                  : choosing === "join"
                    ? "Sign in or sign up to join."
                    : `Sign in with ${masked || "your address"} to turn this down.`}
              </p>
              {PROVIDERS.map((p) => (
                <button type="button" class="button" key={p.id} onClick={() => props.onSignIn(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <Story pond={invite.pond} inviter={invite.inviter} members={invite.members} />
      {pending ? (
        <section class="closing">
          <h2>{invite.pond} is waiting.</h2>
          {mainButtons}
        </section>
      ) : null}
      <footer class="foot">
        <span>Squeak · squeak.onslate.in</span>
        {pending && masked ? (
          <span>
            This invitation was sent to {masked} and expires {expiryShort(invite.expiresAt)}
          </span>
        ) : null}
      </footer>
    </main>
  );
}
