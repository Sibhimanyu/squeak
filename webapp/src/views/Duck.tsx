// A Duck's conversation (issue #137): what was said, the agent's replies, tool steps folded to one line, the decision card with
// lettered options while a question is open, and the composer. The Owner can Stop a working Duck. Code, diffs and ducklings are
// the Mac's: each is one plain line ending "Open on your Mac". An approval is shown, never answerable here.

import { useState } from "preact/hooks";
import type { PondSummary } from "../../../src/shared/shapes.js";
import { age } from "../format.js";
import { canOf } from "../pond/can.js";
import { conversationOf, firstName, letter } from "../pond/derive.js";
import type { PondSession, SendResult } from "../pond/session.js";
import type { Route } from "../router.js";
import { Avatar, tint } from "./marks.js";
import { deletedText } from "./Pond.js";
import { BackBar, Composer, FAILED_SEND, OpenOnMac, useSession, useStickToBottom } from "./parts.js";

type DuckRoute = Extract<Route, { name: "duck" }>;

interface PendingReply {
  id: string;
  text: string;
  at: number;
}

export interface DuckScreenProps {
  route: DuckRoute;
  pond: PondSummary | undefined;
  /** The Owner deleted this Pond: its name, for "<name> was deleted." */
  deletedName?: string | undefined;
  session: PondSession | null;
  now?: number;
}

export function DuckScreen(props: DuckScreenProps) {
  const { route, pond, session } = props;
  const state = useSession(session);
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [answered, setAnswered] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);
  const data = state?.data ?? null;
  const duck = data?.ducks.find((d) => d.id === route.duckId) ?? null;
  const conv = duck && data ? conversationOf(duck, data.events.get(duck.id) ?? [], state?.selfId ?? "") : null;
  const stick = useStickToBottom(`${conv?.items.length ?? 0}:${pending.length}:${conv?.question?.requestId ?? ""}`);

  if (!pond || !state || !session) {
    return (
      <section class="screen" data-screen="duck">
        <BackBar route={route} title="Duck" />
        <p class="empty">{props.deletedName ? deletedText(props.deletedName) : "This Duck is not in your list."}</p>
      </section>
    );
  }
  if (state.access !== "ready" || !data) {
    return (
      <section class="screen" data-screen="duck">
        <BackBar route={route} title="Duck" />
        <p class="empty">{state.access === "connecting" ? "Connecting…" : "Not available."}</p>
      </section>
    );
  }
  if (!duck || !conv) {
    return (
      <section class="screen" data-screen="duck">
        <BackBar route={route} title="Duck" />
        <p class="empty">That Duck is not shared with this Pond.</p>
      </section>
    );
  }

  const now = props.now ?? Date.now();
  const owner = firstName(pond.ownerName);
  const can = canOf(pond.role, state.selfId, data.policy, duck.starter);
  // A reply waiting to show up as a real message goes away when the same words from this person arrive.
  const echoed = (p: PendingReply): boolean =>
    conv.items.some((i) => i.kind === "message" && i.mine && i.text === p.text && i.at >= p.at - 120_000);
  const waiting = pending.filter((p) => !echoed(p));

  const reply = async (text: string): Promise<SendResult> => {
    const result = await session.command({ kind: "message", threadId: duck.id, text });
    if (result === "sent") setPending((all) => [...all, { id: `p${Date.now()}-${all.length}`, text, at: Date.now() }]);
    return result;
  };

  return (
    <section class="screen pa" data-screen="duck" data-role={pond.role} style={tint(pond.pondId)}>
      <BackBar
        route={route}
        title={duck.title}
        sub={`${duck.starterName} · ${duck.state === "working" ? "Working" : duck.state === "waiting" ? "Waiting" : "Idle"}`}
      />
      {can.stop === true && duck.state === "working" ? (
        <div class="actions">
          <button
            type="button"
            class="outline"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void session.command({ kind: "stop", threadId: duck.id }).then((r) => r !== "sent" && setStopping(false));
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        </div>
      ) : null}
      <div class="feed" ref={stick.ref} onScroll={stick.onScroll} data-feed="duck">
        {conv.items.length === 0 && waiting.length === 0 ? <p class="empty">Nothing said yet.</p> : null}
        <ol>
          {conv.items.map((item) => {
            switch (item.kind) {
              case "message":
                return (
                  <li key={item.id} class={`msg${item.mine ? " mine" : ""}`} data-item={item.id}>
                    {item.mine ? null : <Avatar name={item.author} small />}
                    <div class="bubble">
                      {item.mine ? null : <span class="who">{item.author}</span>}
                      <p>{item.text}</p>
                      {item.mine ? null : <span class="meta">{age(now, item.at)}</span>}
                    </div>
                    {item.mine ? <span class="meta">{age(now, item.at)}</span> : null}
                  </li>
                );
              case "reply":
                return (
                  <li key={item.id} class="reply" data-item={item.id}>
                    <p>{item.text}</p>
                  </li>
                );
              case "tools":
                return (
                  <li key={item.id} class="tools" data-item={item.id}>
                    {item.labels.length > 1 ? (
                      <details>
                        <summary>{item.label}</summary>
                        <ul>
                          {item.labels.map((l, i) => (
                            <li key={i}>{l}</li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <span>{item.label}</span>
                    )}
                  </li>
                );
              case "changed":
                return (
                  <li key={item.id} data-item={item.id}>
                    <OpenOnMac text={item.text} />
                  </li>
                );
              case "approval":
                return (
                  <li key={item.id} data-item={item.id}>
                    <OpenOnMac text={`Waiting for approval: ${item.label}`} />
                  </li>
                );
            }
          })}
          {waiting.map((p) => (
            <li key={p.id} class="msg mine pending" data-item={p.id}>
              <div class="bubble">
                <p>{p.text}</p>
              </div>
              <span class="meta">Sent</span>
            </li>
          ))}
        </ol>
      </div>
      {conv.question && !answered.includes(conv.question.requestId) ? (
        <Decision
          key={conv.question.requestId}
          question={conv.question}
          canAnswer={can.answerQuestion === true}
          answer={async (answer) => {
            const requestId = conv.question!.requestId;
            const result = await session.command({ kind: "answer", threadId: duck.id, requestId, answer });
            if (result === "sent") setAnswered((a) => [...a, requestId]);
            return result;
          }}
        />
      ) : null}
      <Composer
        role={pond.role}
        owner={owner}
        label={`Reply to ${duck.title}`}
        placeholder="Reply"
        send={reply}
        blocked={can.messageDuck === true ? undefined : can.messageDuck}
      />
    </section>
  );
}

/** The decision card: the question, then lettered options (a real choice each) or, with none, a free answer. */
function Decision(props: {
  question: { requestId: string; text: string; options: string[] };
  canAnswer: boolean;
  answer: (answer: string) => Promise<SendResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { question } = props;
  const choose = async (answer: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await props.answer(answer);
    setBusy(false);
    if (result !== "sent") setFailed(true);
  };
  return (
    <section class="decision" data-block="question" aria-label="Question">
      <p class="question">{question.text}</p>
      {props.canAnswer && question.options.length > 0 ? (
        <ol class="options">
          {question.options.map((option, i) => (
            <li key={i}>
              <button type="button" class="option" disabled={busy} onClick={() => void choose(option)}>
                <span class="letter">{letter(i)}</span>
                <span>{option}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {props.canAnswer && question.options.length === 0 ? (
        <Composer role="member" owner="" label="Your answer" placeholder="Your answer" send={props.answer} />
      ) : null}
      {failed ? (
        <p class="failure-line" role="alert">
          {FAILED_SEND}
        </p>
      ) : null}
    </section>
  );
}
