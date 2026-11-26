import type { InvitePreview } from "../../../src/shared/shapes.js";
import type { AuthState } from "../auth/auth.js";
import type { Provider } from "../auth/session.js";

export interface SignInProps {
  state: AuthState;
  /** Set when the link was an invitation: shown above the buttons. */
  invite: InvitePreview | null;
  onSignIn: (provider: Provider) => void;
  onRetry: () => void;
}

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "zoho", label: "Continue with Zoho" },
  { id: "google", label: "Continue with Google" },
  { id: "email", label: "Continue with email" },
];

const MailIcon = () => (
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </svg>
);

/** A Pond or person's colour: one hue from its name, drawn by the stylesheet for both themes. */
export const hueOf = (name: string): number => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

export const expiryText = (epochMs: number): string =>
  new Date(epochMs).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const WHY: Record<Exclude<InvitePreview["state"], "pending">, (i: InvitePreview) => string> = {
  withdrawn: (i) => `${i.inviter} withdrew this invitation.`,
  declined: () => "This invitation was declined.",
  joined: () => "This invitation was already used.",
  expired: () => "This invitation has expired.",
};

function InviteCard({ invite }: { invite: InvitePreview }) {
  return (
    <section class="invite-card" aria-label="Invitation">
      <div class="avatars" aria-hidden="true">
        <span class="avatar person" style={{ "--h": hueOf(invite.inviter) }}>
          {invite.inviter.charAt(0).toUpperCase()}
        </span>
        <span class="avatar tile" style={{ "--h": hueOf(invite.pond) }}>
          {invite.pond.charAt(0).toUpperCase()}
        </span>
      </div>
      <h2>
        {invite.inviter} invited you to {invite.pond}
      </h2>
      {invite.state === "pending" ? (
        <p>
          {invite.masked
            ? `Sign in with ${invite.masked} and ${invite.pond} will be waiting.`
            : `${invite.pond} will be waiting.`}
          <br />
          The invitation expires {expiryText(invite.expiresAt)}.
        </p>
      ) : (
        <p>
          {WHY[invite.state](invite)}
          {invite.members.length > 0 ? (
            <>
              <br />
              In {invite.pond}: {invite.members.join(", ")}.
            </>
          ) : null}
        </p>
      )}
    </section>
  );
}

export function SignIn({ state, invite, onSignIn, onRetry }: SignInProps) {
  return (
    <main class="signin">
      <picture>
        <source srcset="brand/squeak-lockup-stacked-paper.svg" media="(prefers-color-scheme: dark)" />
        <img class="lockup" src="brand/squeak-lockup-stacked-ink.svg" alt="Squeak" width="210" />
      </picture>
      {state.status === "failed" ? (
        <div class="failure" role="alert">
          <p>{state.message}</p>
          <button type="button" class="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : state.status === "checking" ? (
        <p class="quiet" role="status">
          Signing you in…
        </p>
      ) : (
        <>
          {invite ? (
            <InviteCard invite={invite} />
          ) : (
            <p class="blurb">
              Squeak is a calm place to follow your Ponds: the people and coding agents working with you, and what needs
              you.
            </p>
          )}
          <div class="buttons">
            {PROVIDERS.map((p) => (
              <button type="button" class="button" key={p.id} onClick={() => onSignIn(p.id)}>
                {p.id === "email" ? <MailIcon /> : null}
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
