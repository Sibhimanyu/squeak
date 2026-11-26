import type { AuthState } from "../auth/auth.js";
import type { Provider } from "../auth/session.js";

export interface SignInProps {
  state: AuthState;
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

export function SignIn({ state, onSignIn, onRetry }: SignInProps) {
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
          <p class="blurb">
            Squeak is a calm place to follow your Ponds: the people and coding agents working with you, and what needs
            you.
          </p>
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
