// A made-up Mac for `?demo=1` (demo-guard.js): the real view shapes (what RemoteBridge.phoneView() sends and
// view-model.js reads) with invented content, plus inert stand-ins for the sync, outbox and stores the page
// normally has, so every screen draws without a channel. Nothing here is ever sent anywhere.

const minutes = (n, now) => new Date(now - n * 60_000).toISOString();

const chat = (now, key, o) => ({
  key,
  conductorSessionId: key,
  label: `${o.repo} · ${o.branch}`,
  title: o.title,
  agent: o.agent ?? "claude",
  state: o.state,
  lastActivityAt: minutes(o.ago, now),
  detail: o.detail ?? null,
  git: o.git ?? null,
  contextPercent: o.context ?? null,
  turnId: `t-${key}`,
  message: o.message ?? null,
  choices: o.choices ?? null,
  question: o.question ?? null,
  asks: o.asks ?? null,
  activity: o.activity ?? null,
  background: o.background ?? null,
  open: true,
  workspacePath: o.path ?? null,
  model: o.model ?? (o.agent === "codex" ? "GPT-5.5" : "Opus 5.5"),
  effort: o.effort ?? (o.agent === "codex" ? "High" : "Medium"),
  pond: o.pond ?? null,
});

/** The tints a project gets in the sidebar (an optional `projectTints` the Mac may send; the page falls back to a hash). */
export const DEMO_TINTS = { storefront: "#e0a030", ledger: "#38bdf8", lantern: "#a78bfa" };

export function demoView(now = Date.now()) {
  const active = [
    chat(now, "c-webhook", {
      repo: "storefront",
      branch: "stripe-retries",
      title: "Add Stripe webhook retries",
      state: "awaiting_approval",
      ago: 2,
      detail: "Wants to run: npm run test -- webhooks",
      message: "Retries are written; I need to run the webhook tests before I touch the queue.",
      git: "+86 −12 · 4 files",
      context: 41,
    }),
    chat(now, "c-migration", {
      repo: "storefront",
      branch: "cart-totals",
      title: "Rounding in cart totals",
      state: "finished",
      ago: 9,
      detail: "Cart totals now round per line.",
      message:
        "Cart totals now round per line instead of per order. Two ways to carry the old orders over.\n\nWhich approach should I take?\n\nA) Backfill every open cart tonight\nB) Round only new carts (recommended)\nC) Leave old carts alone and flag them",
      asks: "Which approach should I take?",
      choices: {
        question: "Which approach should I take?",
        recommended: "B",
        options: [
          { letter: "A", title: "Backfill every open cart tonight" },
          { letter: "B", title: "Round only new carts" },
          { letter: "C", title: "Leave old carts alone and flag them" },
        ],
      },
      git: "+34 −9 · 3 files",
      path: "~/conductor/workspaces/storefront/cart-totals",
      context: 63,
    }),
    chat(now, "c-import", {
      repo: "ledger",
      branch: "csv-import",
      title: "Import bank CSVs",
      state: "working",
      ago: 1,
      detail: "Writing the column mapper",
      git: "+211 −4 · 7 files",
      path: "~/conductor/workspaces/ledger/csv-import",
      context: 28,
      activity: {
        total: 14,
        steps: [
          { kind: "thinking", text: "Bank exports disagree on the date column; map by header, not position." },
          { kind: "tool", text: "Read src/import/mapper.ts" },
          { kind: "tool", text: "Edit src/import/mapper.ts" },
          { kind: "note", text: "Mapper handles three bank layouts. Now the parser tests." },
          { kind: "tool", text: "Run npm test -- import" },
          { kind: "background", text: "Waiting on 2 workers" },
        ],
      },
      background: [
        {
          id: "a1",
          kind: "agent",
          label: "Write parser tests for the three layouts",
          status: "running",
          background: true,
          startedAt: minutes(4, now),
        },
        {
          id: "a2",
          kind: "agent",
          label: "Check currency edge cases",
          status: "done",
          background: true,
          startedAt: minutes(8, now),
          endedAt: minutes(3, now),
          summary: "Found two rounding cases; both covered.",
        },
        {
          id: "s1",
          kind: "shell",
          label: "npm run dev",
          status: "running",
          background: true,
          startedAt: minutes(31, now),
        },
      ],
    }),
    chat(now, "c-reconcile", {
      repo: "ledger",
      branch: "reconcile",
      title: "Nightly reconcile job",
      agent: "codex",
      state: "working",
      ago: 3,
      detail: "Running the migration dry run",
      context: 52,
      activity: { total: 6, steps: [{ kind: "tool", text: "Run node scripts/reconcile.mjs --dry" }] },
    }),
    chat(now, "c-fx", {
      repo: "ledger",
      branch: "fx-rates",
      title: "Cache FX rates for an hour",
      state: "finished",
      ago: 26,
      detail: "Rates are cached and refreshed on a timer.",
      message: "Rates are cached for an hour and refreshed on a timer. Tests cover the expiry and the failure path.",
      git: "+142 −31 · 5 files",
      path: "~/conductor/workspaces/ledger/fx-rates",
      context: 37,
      pond: {
        name: "Shop team",
        members: [
          { name: "Asha", online: true },
          { name: "Dev", online: true },
          { name: "Mira", online: false },
        ],
      },
    }),
    chat(now, "c-search", {
      repo: "lantern",
      branch: "search-index",
      title: "Rebuild the search index at build time",
      state: "finished",
      ago: 55,
      detail: "Index builds in 4 s and ships with the site.",
      message: "The index is generated during the build and ships with the site. It is 38 KB gzipped.",
      git: "+97 −58 · 6 files",
      context: 71,
    }),
  ];
  const recent = [
    chat(now, "c-receipts", {
      repo: "storefront",
      branch: "email-receipts",
      title: "Receipt emails",
      state: "finished",
      ago: 190,
      detail: "Receipts send after capture.",
      message: "Receipts send after the payment is captured.",
      git: "+58 −2 · 3 files",
    }),
    chat(now, "c-dark", {
      repo: "lantern",
      branch: "dark-mode",
      title: "Dark mode for the docs",
      state: "idle",
      ago: 60 * 7,
      detail: "Idle",
    }),
    chat(now, "c-changelog", {
      repo: "lantern",
      branch: "changelog",
      title: "Generate the changelog page",
      state: "error",
      ago: 60 * 26,
      detail: "The release notes folder was empty.",
    }),
    chat(now, "c-promo", {
      repo: "storefront",
      branch: "promo-banner",
      title: "Promo banner",
      state: "idle",
      ago: 60 * 50,
      detail: "Idle",
    }),
  ];
  return {
    mac: "Sibhi's MacBook Pro",
    sessions: active,
    recent,
    recentMore: false,
    projectIcons: {},
    projectTints: DEMO_TINTS,
    keepAwake: true,
    awakeUntil: new Date(now + 95 * 60_000).toISOString(),
    awakeLid: "on",
    macPower: { percent: 82, onBattery: true, lidClosed: false },
    usage: {
      claude: {
        fiveHour: { usedPercent: 46, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
        sevenDay: { usedPercent: 22, resetsAt: new Date(now + 4 * 86_400_000).toISOString() },
        observedAt: minutes(2, now),
      },
      codex: {
        fiveHour: { usedPercent: 12, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
        weekly: { usedPercent: 31, resetsAt: new Date(now + 5 * 86_400_000).toISOString() },
        observedAt: minutes(6, now),
      },
    },
    workspaces: [
      { id: "w1", label: "storefront · stripe-retries", defaultAgent: "claude" },
      { id: "w2", label: "ledger · csv-import", defaultAgent: "claude" },
    ],
    repos: [
      { id: "r1", name: "storefront" },
      { id: "r2", name: "ledger" },
      { id: "r3", name: "lantern" },
    ],
    account: { email: "sibhi@example.com" },
    ponds: [
      {
        id: "pond-1",
        name: "Shop team",
        members: [
          { name: "Asha", online: true },
          { name: "Dev", online: true },
          { name: "Mira", online: false },
        ],
      },
      { id: "pond-2", name: "Docs crew", members: [{ name: "Noor", online: false }] },
    ],
  };
}

const DEMO_FILES = [
  { path: "src/import/mapper.ts", insertions: 96, deletions: 2 },
  { path: "src/import/parser.test.ts", insertions: 64, deletions: 0, untracked: true },
  { path: "src/import/layouts/chase.ts", insertions: 28, deletions: 0, untracked: true },
  { path: "src/import/index.ts", insertions: 12, deletions: 1 },
  { path: "src/currency.ts", insertions: 8, deletions: 1 },
  { path: "package.json", insertions: 3, deletions: 0 },
  { path: "docs/import.md", insertions: 0, deletions: 0, binary: true },
];

const demoDiff = () => ({
  baseRef: "origin/main",
  insertions: 211,
  deletions: 4,
  truncated: false,
  files: DEMO_FILES.map((f) => ({ binary: false, untracked: false, ...f })),
});

const demoPatch = (index) => ({
  index,
  path: DEMO_FILES[index]?.path ?? "",
  text: `@@ -1,4 +1,9 @@\n import { parse } from "~/parse";\n-const COLUMN = 3;\n+const header = (row) => row.findIndex((c) => /date/i.test(c));\n+export const mapRow = (row, at) => ({ date: row[at] });\n`,
});

/** What the page's `ui` holds once a Mac is "paired": inert replacements for everything that would talk to the channel. */
export function demoRuntime(now = Date.now()) {
  const view = demoView(now);
  const sync = {
    channel: { db: { closeAll() {} } },
    signingKey: null,
    state: { view, streamUp: true, aliveAt: now, live: null, error: null },
    watch() {},
    start() {},
    stop() {},
    wake() {},
    setVerbose() {},
    showMoreRecent() {},
    command: async () => null,
  };
  const outbox = {
    list: () => [],
    isStopping: () => false,
    isSending: () => false,
    noteQueue() {},
    hiddenQueued: new Set(),
    queueProblem: null,
    problemFor: new Map(),
    restoredDraft: new Map(),
    draftRestored() {},
    send: async () => ({ ok: false }),
    retry() {},
    edit() {},
    stop: async () => undefined,
    steerQueued: async () => undefined,
    removeQueued: async () => null,
    reconcileRestored: async () => undefined,
    dispose: async () => undefined,
  };
  // Any command answers "not in the preview", so a button that is pressed says so rather than doing anything.
  const commands = new Proxy(
    {},
    {
      get: (_, name) => async (input) =>
        name === "diff"
          ? { ok: true, result: input?.file === undefined ? { diff: demoDiff() } : { patch: demoPatch(input.file) } }
          : { ok: false, reason: "Not available in the preview." },
    },
  );
  const read = {
    seen: new Map(),
    markSeen() {},
    watchIfNew() {},
    flush: async () => undefined,
    dispose: async () => undefined,
  };
  const history = { record() {}, flush: async () => undefined, load: async () => ({}), dispose: async () => undefined };
  const at = (n) => minutes(n, Date.now());
  const lastHistory = {
    "c-import": [
      { role: "user", text: "Import the three bank CSV layouts. Map columns by header, not position.", at: at(22) },
      {
        role: "assistant",
        text: "I'll start with the column mapper, then write parser tests for each layout. The exports disagree on the date column, so I match by header.",
        at: at(20),
      },
      { role: "user", text: "Good. Keep the Chase layout in its own file.", at: at(12) },
      {
        role: "assistant",
        text: "Done: the Chase layout lives in src/import/layouts/chase.ts. I'm fanning out two workers for the parser tests and the currency edge cases.",
        at: at(9),
      },
    ],
    "c-migration": [
      { role: "user", text: "Make cart totals round per line, not per order.", at: at(40) },
      {
        role: "assistant",
        text: "Cart totals now round per line instead of per order. Two ways to carry the old orders over.\n\nWhich approach should I take?\n\nA) Backfill every open cart tonight\nB) Round only new carts (recommended)\nC) Leave old carts alone and flag them",
        at: at(9),
      },
    ],
    "c-fx": [
      { role: "user", text: "Cache the FX rates for an hour.", at: at(60) },
      {
        role: "assistant",
        text: "Rates are cached for an hour and refreshed on a timer. Tests cover the expiry and the failure path.",
        at: at(26),
      },
    ],
  };
  return {
    view,
    lastHistory,
    sync,
    outbox,
    commands,
    read,
    history,
    record: { state: "paired", macName: view.mac, provider: "demo", deviceName: "Preview" },
  };
}
