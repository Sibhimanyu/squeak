// Pieces the Pond and Duck screens share: the back bar, the session hook, "Open on your Mac" lines, the composer and the
// reason a Viewer sees instead of one.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { PondRole } from "../../../src/shared/shapes.js";
import type { SendResult, PondSession, SessionState } from "../pond/session.js";
import { parentRoute, routePath, type Route } from "../router.js";

export const FAILED_SEND = "That didn't go through. Try again.";
export const OPEN_ON_MAC = "Open on your Mac";
export const href = (route: Route): string => `#${routePath(route)}`;

export function BackBar({ route, title, sub }: { route: Route; title: string; sub?: string | undefined }) {
  const parent = parentRoute(route);
  return (
    <header class="bar">
      {parent ? (
        <a class="back" href={href(parent)} aria-label="Back">
          ‹
        </a>
      ) : null}
      <div class="titles">
        <h1>{title}</h1>
        {sub ? <span class="subtitle">{sub}</span> : null}
      </div>
    </header>
  );
}

export function useSession(session: PondSession | null): SessionState | null {
  const [state, setState] = useState<SessionState | null>(session ? session.state() : null);
  useEffect(() => {
    setState(session ? session.state() : null);
    return session?.subscribe(setState);
  }, [session]);
  return state;
}

/** A thing the web does not do: one plain line that says where it is done. Not a control. */
export function OpenOnMac({ text }: { text: string }) {
  return (
    <p class="mac-line" data-open-on-mac="">
      {text} · {OPEN_ON_MAC}
    </p>
  );
}

/** Keeps the newest in view: scrolls to the bottom when something is added, unless the person has scrolled up to read. */
export function useStickToBottom(signal: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [signal]);
  const onScroll = (): void => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  return { ref, onScroll };
}

export const VIEWER_LINE = (owner: string): string =>
  `You can read this Pond. Ask ${owner} to make you a Member to write.`;

export interface ComposerProps {
  role: PondRole;
  /** The Owner's first name (the Viewer line names them). */
  owner: string;
  label: string;
  placeholder: string;
  send: (text: string) => Promise<SendResult>;
  /** A quiet line under the box ("Sibhi approves Tasks"). */
  note?: string | undefined;
}

/** The composer at the bottom. A Viewer gets the reason instead (never a dead box). A failure keeps the words and says so once. */
export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (props.role === "viewer") {
    return (
      <p class="readonly" data-readonly="">
        {VIEWER_LINE(props.owner)}
      </p>
    );
  }
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setFailed(false);
    const result = await props.send(body);
    setBusy(false);
    if (result === "sent") setText("");
    else setFailed(true);
  };
  return (
    <form class="composer" onSubmit={(e) => void submit(e)}>
      <textarea
        aria-label={props.label}
        placeholder={props.placeholder}
        rows={1}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) void submit(e);
        }}
      />
      <button type="submit" class="primary" disabled={busy || !text.trim()}>
        Send
      </button>
      {failed ? (
        <p class="failure-line" role="alert">
          {FAILED_SEND}{" "}
          <button type="submit" class="link">
            Try again
          </button>
        </p>
      ) : null}
      {props.note ? <p class="note">{props.note}</p> : null}
    </form>
  );
}
