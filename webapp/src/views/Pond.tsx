// A Pond (issue #137): Room and Ducks tabs, Room first. The Room reads oldest to newest with the newest at the bottom and the
// composer under it; the Ducks tab puts what is working first. What a person may do follows their role: an Owner posts, makes
// Tasks, starts and stops Ducks; a Member posts and replies, and their Task or Duck waits for the Owner; a Viewer reads and is told
// why they cannot write. Things the web does not do are one plain line ending "Open on your Mac", never a dead control.

import { useEffect, useState } from "preact/hooks";
import type { PondRole, PondSummary } from "../../../src/shared/shapes.js";
import { age } from "../format.js";
import { duckGroups, firstName, roomItems, taskLine } from "../pond/derive.js";
import { canMakeTask, EARLIER_LINE, roomPostIdOf } from "../pond/room-format.js";
import type { Duck } from "../pond/duck-format.js";
import type { PondSession, SendResult, SessionState } from "../pond/session.js";
import type { Connection } from "../relay/live.js";
import type { Route } from "../router.js";
import { connectionLine } from "./Ponds.js";
import { Avatar, tint, Warning, Working } from "./marks.js";
import { BackBar, Composer, FAILED_SEND, href, OpenOnMac, useSession, useStickToBottom } from "./parts.js";

type PondRoute = Extract<Route, { name: "pond" }>;

export const connectingText = (owner: string): string => `Connecting: waiting for ${firstName(owner)}'s Mac`;
export const offlineText = (owner: string): string =>
  `${firstName(owner)}'s Mac is offline. Your messages wait and arrive in order.`;
const ROLE_LABEL: Record<PondRole, string> = { owner: "Owner", member: "Member", viewer: "Viewer" };

interface PendingPost {
  /** The Room post id the message will have once the Owner's Mac applies it: the row keeps this key from sending to landed. */
  postId: string;
  inboxId: string;
  text: string;
  at: number;
  status: "sending" | "sent" | "failed";
}
interface PendingDuck {
  requestId: string;
  text: string;
  status: "waiting";
}

export interface PondScreenProps {
  route: PondRoute;
  pond: PondSummary | undefined;
  session: PondSession | null;
  connection: Connection;
  /** The Pond has been looked at up to its newest change. */
  onSeen: () => void;
  now?: number;
}

export function PondScreen(props: PondScreenProps) {
  const { route, pond, session } = props;
  const state = useSession(session);
  const [pending, setPending] = useState<PendingPost[]>([]);
  const [asked, setAsked] = useState<string[]>([]);
  const [ducks, setDucks] = useState<PendingDuck[]>([]);
  const head = state?.data?.head ?? 0;
  useEffect(() => {
    if (head > 0) props.onSeen();
    // onSeen is stable per Pond; the head is what changes
  }, [head, pond?.pondId]);
  if (!pond) {
    return (
      <section class="screen" data-screen="pond">
        <BackBar route={route} title="Pond" />
        <p class="empty">This Pond is not in your list.</p>
      </section>
    );
  }
  const now = props.now ?? Date.now();
  const owner = pond.ownerName;
  const line = connectionLine(props.connection);
  const sub = `${pond.mine ? "Your Pond" : `${firstName(owner)}'s Pond`} · ${ROLE_LABEL[pond.role]}${line ? ` · ${line}` : ""}`;
  const data = state?.data ?? null;

  return (
    <section class="screen" data-screen="pond" data-role={pond.role}>
      <BackBar route={route} title={pond.name} sub={sub} />
      {data && data.members.length > 0 ? (
        <div class="flock" aria-label="People in this Pond">
          {data.members.map((m) => (
            <Avatar key={m.id} name={m.name} small />
          ))}
        </div>
      ) : null}
      <nav class="tabs" role="tablist" aria-label="Pond">
        <a role="tab" aria-selected={route.tab === "room"} href={href({ ...route, tab: "room" })}>
          Room
        </a>
        <a role="tab" aria-selected={route.tab === "ducks"} href={href({ ...route, tab: "ducks" })}>
          Ducks
        </a>
      </nav>
      <Status state={state} owner={owner} />
      {state?.access === "ready" && data && session ? (
        route.tab === "room" ? (
          <RoomTab
            pond={pond}
            session={session}
            state={state}
            now={now}
            pending={pending}
            setPending={setPending}
            asked={asked}
            setAsked={setAsked}
          />
        ) : (
          <DucksTab pond={pond} session={session} state={state} now={now} ducks={ducks} setDucks={setDucks} />
        )
      ) : null}
    </section>
  );
}

/** What stands in for the content until there is some: connecting, removed, or unreachable. */
function Status({ state, owner }: { state: SessionState | null; owner: string }) {
  if (!state || !state.loaded) return <p class="empty">Loading…</p>;
  if (state.access === "connecting") {
    return (
      <p class="banner connecting" role="status" data-state="connecting">
        {connectingText(owner)}
      </p>
    );
  }
  if (state.access === "removed") {
    return (
      <p class="banner" role="alert" data-state="removed">
        You no longer have access to this Pond.
      </p>
    );
  }
  if (state.access === "failed") {
    return (
      <p class="banner" role="alert" data-state="failed">
        Squeak can't be reached right now.
      </p>
    );
  }
  return state.ownerOffline ? (
    <p class="banner offline" role="status" data-state="offline">
      {offlineText(owner)}
    </p>
  ) : null;
}

function RoomTab(props: {
  pond: PondSummary;
  session: PondSession;
  state: SessionState;
  now: number;
  pending: PendingPost[];
  setPending: (update: (p: PendingPost[]) => PendingPost[]) => void;
  asked: string[];
  setAsked: (update: (a: string[]) => string[]) => void;
}) {
  const { pond, session, state, now } = props;
  const data = state.data!;
  const self = data.members.find((m) => m.id === state.selfId);
  const items = roomItems(data, state.selfId, self?.name ?? "");
  const landed = new Set(data.posts.map((p) => p.id));
  const waiting = props.pending.filter((p) => !landed.has(p.postId));
  const taskOf = new Map(data.tasks.map((t) => [t.messageId, t]));
  const owner = firstName(pond.ownerName);
  const canWrite = pond.role !== "viewer";
  const stick = useStickToBottom(`${items.length}:${waiting.length}:${waiting.map((w) => w.status).join()}`);

  const send = async (item: PendingPost): Promise<void> => {
    props.setPending((all) => all.map((p) => (p.postId === item.postId ? { ...p, status: "sending" } : p)));
    const result = await session.post(item.inboxId, item.text);
    props.setPending((all) =>
      all.map((p) => (p.postId === item.postId ? { ...p, status: result === "sent" ? "sent" : "failed" } : p)),
    );
  };
  const compose = async (text: string): Promise<SendResult> => {
    const inboxId = session.newPostId();
    const item: PendingPost = { postId: roomPostIdOf(inboxId), inboxId, text, at: Date.now(), status: "sending" };
    props.setPending((all) => [...all, item]);
    const result = await session.post(inboxId, text);
    props.setPending((all) =>
      all.map((p) => (p.postId === item.postId ? { ...p, status: result === "sent" ? "sent" : "failed" } : p)),
    );
    // A failure stays in the list under its own words, with Try again; the box clears either way.
    return "sent";
  };
  const makeTask = async (messageId: string): Promise<void> => {
    props.setAsked((a) => [...a, messageId]);
    const result = await session.makeTask(messageId);
    if (result !== "sent") props.setAsked((a) => a.filter((id) => id !== messageId));
  };

  return (
    <div class="room" data-tab="room">
      {data.tasks.length > 0 ? (
        <section class="tasks" aria-label="Tasks" data-block="tasks">
          <h2>Tasks</h2>
          <ul>
            {data.tasks.map((t) => (
              <li key={t.id}>{taskLine(t)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <div class="feed" ref={stick.ref} onScroll={stick.onScroll} data-feed="room">
        {data.earlier ? <p class="earlier">{EARLIER_LINE}</p> : null}
        {items.length === 0 && waiting.length === 0 ? <p class="empty">The Room is empty.</p> : null}
        <ol>
          {/* One list, keyed by Room post id: a waiting message and the post it becomes share a key, so it never remounts. */}
          {[
            ...items.map((item) =>
              item.kind === "message" ? (
                <li key={item.id} class={`msg${item.mine ? " mine" : ""}`} data-post={item.id}>
                  {item.mine ? null : <Avatar name={item.author} small />}
                  <div class="bubble">
                    {item.mine ? null : <span class="who">{item.author}</span>}
                    <p>{item.text}</p>
                    <span class="meta">
                      {age(now, item.at)}
                      {canWrite && canMakeTask(item.post) && !taskOf.has(item.id) ? (
                        props.asked.includes(item.id) ? (
                          <span class="asked"> · Task requested</span>
                        ) : (
                          <>
                            {" · "}
                            <button type="button" class="link make-task" onClick={() => void makeTask(item.id)}>
                              Make task
                            </button>
                          </>
                        )
                      ) : null}
                      {taskOf.has(item.id) ? <span class="asked"> · Task: {taskOf.get(item.id)!.state}</span> : null}
                    </span>
                  </div>
                </li>
              ) : (
                <li key={item.id} class="state-line" data-post={item.id}>
                  <span class="duck" style={tint(item.duck)} aria-hidden="true" />
                  <span>
                    <strong>{item.duck}</strong> {item.text}
                    <span class="meta"> · {age(now, item.at)}</span>
                    {item.canvases.map((c) => (
                      <OpenOnMac key={c.id} text={`Canvas “${c.title}”`} />
                    ))}
                  </span>
                </li>
              ),
            ),
            ...waiting.map((p) => (
              <li key={p.postId} class="msg mine pending" data-post={p.postId} data-status={p.status}>
                <div class="bubble">
                  <p>{p.text}</p>
                  {p.status === "failed" ? (
                    <span class="failure-line" role="alert">
                      {FAILED_SEND}{" "}
                      <button type="button" class="link" onClick={() => void send(p)}>
                        Try again
                      </button>
                    </span>
                  ) : (
                    <span class="meta">{p.status === "sending" ? "Sending…" : "Sent"}</span>
                  )}
                </div>
              </li>
            )),
          ]}
        </ol>
      </div>
      <Composer
        role={pond.role}
        owner={owner}
        label="Message the Room"
        placeholder="Message the Room"
        send={compose}
        note={pond.role === "member" ? `${owner} approves Tasks` : undefined}
      />
    </div>
  );
}

function DuckRow({ duck, now, pond }: { duck: Duck; now: number; pond: string }) {
  return (
    <li>
      <a class="item" href={href({ name: "duck", pondId: pond, duckId: duck.id })} data-duck={duck.id}>
        <span class="duck" style={tint(duck.id)} aria-hidden="true" />
        <span class="text">
          <strong>{duck.title}</strong>
          <span class="sub">
            {duck.starterName} · {duck.agent}
          </span>
        </span>
        {duck.state === "waiting" && duck.waitingFor !== "approval" ? (
          <Warning />
        ) : duck.state === "working" ? (
          <Working />
        ) : (
          <span class="age">{age(now, duck.updatedAt)}</span>
        )}
      </a>
    </li>
  );
}

function DucksTab(props: {
  pond: PondSummary;
  session: PondSession;
  state: SessionState;
  now: number;
  ducks: PendingDuck[];
  setDucks: (update: (d: PendingDuck[]) => PendingDuck[]) => void;
}) {
  const { pond, session, state, now } = props;
  const data = state.data!;
  const [starting, setStarting] = useState(false);
  const owner = firstName(pond.ownerName);
  const groups = duckGroups(data.ducks);
  const shownRequests = new Set(data.ducks.flatMap((d) => (d.requestId ? [d.requestId] : [])));
  const waiting = props.ducks.filter((d) => !shownRequests.has(d.requestId));

  const start = async (text: string): Promise<SendResult> => {
    const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const result = await session.startDuck({ requestId, text });
    if (result !== "sent") return result;
    // Kept until the Duck itself appears (its thread names this request) or the Owner declines.
    props.setDucks((all) => [...all, { requestId, text, status: "waiting" }]);
    setStarting(false);
    return "sent";
  };

  return (
    <div class="ducks" data-tab="ducks">
      {pond.role === "viewer" ? null : starting ? (
        <Composer
          role={pond.role}
          owner={owner}
          label="First message for the new Duck"
          placeholder="What should the Duck do?"
          send={start}
          note={pond.role === "member" ? `${owner} approves new Ducks` : undefined}
        />
      ) : (
        <div class="start">
          <button type="button" class="outline" onClick={() => setStarting(true)}>
            Start a Duck
          </button>
          {pond.role === "member" ? <span class="note">{owner} approves new Ducks</span> : null}
        </div>
      )}
      {waiting.length > 0 ? (
        <ul class="card list-card" data-block="starting">
          {waiting.map((d) => (
            <li key={d.requestId} class="item starting" data-status={d.status}>
              <span class="duck" aria-hidden="true" />
              <span class="text">
                <strong>{d.text}</strong>
                <span class="sub">{pond.role === "owner" ? "Starting…" : `Waiting for ${owner}`}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.working.length > 0 ? (
        <section data-block="working">
          <h2>Working</h2>
          <ul class="card list-card">
            {groups.working.map((d) => (
              <DuckRow key={d.id} duck={d} now={now} pond={pond.pondId} />
            ))}
          </ul>
        </section>
      ) : null}
      {groups.earlier.length > 0 ? (
        <section data-block="earlier">
          <h2>Earlier</h2>
          <ul class="card list-card">
            {groups.earlier.map((d) => (
              <DuckRow key={d.id} duck={d} now={now} pond={pond.pondId} />
            ))}
          </ul>
        </section>
      ) : null}
      {data.ducks.length === 0 && waiting.length === 0 ? <p class="empty">No Ducks yet.</p> : null}
    </div>
  );
}
