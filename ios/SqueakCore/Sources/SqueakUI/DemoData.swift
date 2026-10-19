#if os(iOS)
import Foundation
import SqueakCore

/// Launch with `-squeak-demo` to see the app without a Mac: screenshots and design review only.
/// `-squeak-demo-replyable` makes the Payment chat a finished one, so its
/// options and composer are live (a chat waiting inside Conductor cannot be
/// answered from a phone, and the demo keeps to that rule).
enum DemoData {
    /// One answer with every kind of block, for the typesetting captures.
    static let richMessage = """
    ## Session isolation

    Each chat now runs in **its own worktree**, and the check fails loudly if two chats ever share one. I touched `src/fleet/isolation.ts` and the launcher in ~/conductor/repos/squeak.

    Two things are worth knowing:

    - The check runs *before* a chat starts
      - it compares the worktree path with every live chat
      - a clash stops the start and names the chat
    - Archived workspaces are ignored
    - [x] Unit tests for the clash case
    - [ ] A test for a symlinked path

    ### How it behaves

    | Case | Before | Now |
    | :--- | :---: | ---: |
    | Two chats, one worktree | silent clash | **refused** |
    | Archived workspace | counted | ignored |
    | Missing directory | crash | `error` card |

    ```ts
    export function assertIsolated(path: string, live: Chat[]): void {
      const clash = live.find((c) => c.worktree === path);
      if (clash) throw new Error(`worktree held by ${clash.title}`);
    }
    ```

    > Existing chats keep their worktree. The check only guards new starts, so a clash that already exists will not be repaired.

    1. Run `npm test` to see the new cases.
    2. Read [the design doc](https://example.com/docs/isolation) before changing the launcher.

    ---

    Say the word and I will cover the symlink case too.
    """

    private static var replyable: Bool { ProcessInfo.processInfo.arguments.contains("-squeak-demo-replyable") }

    private static func id(_ n: Int) -> String { String(format: "d0000000-0000-4000-8000-%012d", n) }

    /// The chats' own titles (§8.2's headline). "idle" is untitled, so it reads `repo · branch`.
    private static let titles = [
        "pay": "Payment retry logic", "search": "Search index migration", "tg": "Telegram message formatting",
        "link": "Fix onboarding deep link", "cache": "API response caching", "iso": "Session isolation checks",
        "copy": "Checkout copy review",
    ]

    private static func titled(_ s: PhoneSnapshot.Session) -> PhoneSnapshot.Session {
        PhoneSnapshot.Session(
            key: s.key, conductorSessionId: s.conductorSessionId, label: s.label, agent: s.agent, state: s.state,
            lastActivityAt: s.lastActivityAt, detail: s.detail, git: s.git, contextPercent: s.contextPercent,
            turnId: s.turnId, message: s.message, choices: s.choices, activity: s.activity, title: titles[s.key])
    }

    static var snapshot: PhoneSnapshot {
        let raw = rawSnapshot
        return PhoneSnapshot(v: raw.v, mac: raw.mac, generatedAt: raw.generatedAt, duck: raw.duck, sessions: raw.sessions.map(titled), usage: usage, workspaces: workspaces)
    }

    /// What the Mac lists for a new chat. `-squeak-demo-no-workspaces` plays a Mac too old to send any.
    private static var workspaces: [PhoneSnapshot.Workspace]? {
        guard !ProcessInfo.processInfo.arguments.contains("-squeak-demo-no-workspaces") else { return nil }
        return [
            .init(id: "w-pay", label: "storefront · payment-retries", defaultAgent: "claude"),
            .init(id: "w-search", label: "atlas · search-migration", defaultAgent: "codex"),
            .init(id: "w-tg", label: "squeak · telegram-formatting", defaultAgent: "claude"),
            .init(id: "w-link", label: "compass · onboarding-link", defaultAgent: "codex"),
            .init(id: "w-cache", label: "atlas · api-caching", defaultAgent: "claude"),
        ]
    }

    /// Claude's reading is a few hours old, as it would be unless Refresh was pressed on the Mac.
    private static var usage: PhoneSnapshot.Usage {
        .init(
            claude: .init(fiveHour: .init(usedPercent: 42, resetsAt: now(2 * 3600 + 10 * 60)),
                          sevenDay: .init(usedPercent: 18, resetsAt: now(4 * 86400 + 5 * 3600)), observedAt: now(-3 * 3600)),
            codex: .init(fiveHour: .init(usedPercent: 9, resetsAt: now(3 * 3600 + 40 * 60)),
                         weekly: .init(usedPercent: 31, resetsAt: now(5 * 86400)), observedAt: now(-30)))
    }

    private static var rawSnapshot: PhoneSnapshot {
        PhoneSnapshot(
            v: 1, mac: "Sibhi's MacBook", generatedAt: now(-4),
            duck: .init(blockedCount: 2, workingCount: 3),
            sessions: [
                .init(key: "pay", conductorSessionId: id(1), label: "storefront · payment-retries", agent: "claude",
                      state: replyable ? "finished" : "awaiting_input",
                      lastActivityAt: now(-120), detail: "How should temporary failures be retried?", git: "+84/−12 · 3 files", contextPercent: 41,
                      turnId: "t1",
                      message: "I added an idempotency check. One decision needs your input.\n\n**How should temporary failures be retried?**\n\n**A) Retry automatically.** 3 attempts with backoff.\n\n**B) Let the customer retry.** Keep checkout available.\n\nBoth prevent duplicate charges.",
                      choices: .init(question: "How should temporary failures be retried?",
                                     options: [.init(letter: "A", title: "Retry automatically — 3 attempts with backoff."),
                                               .init(letter: "B", title: "Let the customer retry — Keep checkout available.")],
                                     recommended: "A")),
                .init(key: "search", conductorSessionId: id(2), label: "atlas · search-migration", agent: "codex", state: "awaiting_approval",
                      lastActivityAt: now(-300), detail: "Codex needs your permission to run a command", git: nil, contextPercent: nil,
                      turnId: nil, message: "Codex needs your permission to run a command", choices: nil),
                .init(key: "tg", conductorSessionId: id(3), label: "squeak · telegram-formatting", agent: "claude", state: "working",
                      lastActivityAt: now(-720), detail: "Running tests", git: "+311/−10 · 20 files", contextPercent: nil,
                      turnId: "t2", message: nil, choices: nil,
                      activity: .init(total: 17, steps: [
                          .init(kind: "note", text: "Checking why bold text arrives as literal asterisks."),
                          .init(kind: "tool", text: "Read src/utils/tg-format.ts"),
                          .init(kind: "thinking", text: "The splitter cuts inside an open tag, so the retry falls back to plain text."),
                          .init(kind: "tool", text: "Edit src/utils/tg-format.ts"),
                          .init(kind: "tool", text: "Run npm test -- tg-format"),
                      ])),
                .init(key: "link", conductorSessionId: id(4), label: "compass · onboarding-link", agent: "codex", state: "working",
                      lastActivityAt: now(-1080), detail: "Editing 2 files", git: nil, contextPercent: 74,
                      turnId: "t3", message: nil, choices: nil,
                      activity: .init(total: 6, steps: [.init(kind: "tool", text: "Edit DeepLinkRouter.swift"), .init(kind: "tool", text: "Edit OnboardingView.swift")])),
                .init(key: "cache", conductorSessionId: id(5), label: "atlas · api-caching", agent: "claude", state: "working",
                      lastActivityAt: now(-1620), detail: "Reading code", git: nil, contextPercent: nil,
                      turnId: "t4", message: nil, choices: nil,
                      activity: .init(total: 3, steps: [.init(kind: "tool", text: "Read src/api/cache.ts")])),
                .init(key: "iso", conductorSessionId: id(6), label: "squeak · session-isolation", agent: "claude", state: "finished",
                      lastActivityAt: now(-3600), detail: "Each session now runs in its own worktree.", git: "+42/−3 · 2 files", contextPercent: nil,
                      turnId: "t5", message: ProcessInfo.processInfo.arguments.contains("-squeak-demo-tail") ? String(richMessage[richMessage.range(of: "```ts")!.lowerBound...]) : richMessage, choices: nil),
                .init(key: "copy", conductorSessionId: id(7), label: "storefront · checkout-copy", agent: "codex", state: "finished",
                      lastActivityAt: now(-7200), detail: "Reviewed the checkout copy.", git: nil, contextPercent: nil,
                      turnId: "t6", message: "Reviewed the checkout copy. Three strings were tightened.", choices: nil),
                .init(key: "idle", conductorSessionId: id(8), label: "compass · release-notes", agent: "claude", state: "idle",
                      lastActivityAt: now(-10800), detail: nil, git: nil, contextPercent: nil,
                      turnId: nil, message: nil, choices: nil),
            ])
    }

    /// A reply already sent from this phone, so the demo shows a "You" bubble.
    static var outbox: [String: [AppModel.SentMessage]] {
        ["pay": [.init(text: "Add retry handling for failed payments.\nPrevent duplicate charges.", date: Date().addingTimeInterval(-300), answersTurn: "t0")],
         // A reply just sent to the working chat: its bubble, then the working row.
         "tg": [.init(text: "Fix the splitter, and make sure tables still render.", date: Date().addingTimeInterval(-150), answersTurn: "t1", status: .steered),
                .init(text: "Also keep the plain-text fallback for anything it still can't parse.", date: Date().addingTimeInterval(-60), answersTurn: "t1", status: .queued(agent: "Claude", steerUnavailable: false))]]
    }

    /// The agent's previous answer in the working chat, kept above its working row.
    static var remembered: [String: RememberedMessage] {
        ["tg": RememberedMessage(
            text: "The splitter cuts messages inside an open tag, so Telegram rejects the markup and the retry falls back to plain text. I can fix the splitter and keep the fallback.",
            atISO: now(-900), turnId: "t1")]
    }

    private static func now(_ offset: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }
}
#endif
