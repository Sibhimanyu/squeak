#if os(iOS)
import Foundation
import SqueakCore

/// Launch with `-squeak-demo` to see the app without a Mac: screenshots and design review only.
/// `-squeak-demo-replyable` makes the Payment chat a finished one, so its
/// options and composer are live (a chat waiting inside Conductor cannot be
/// answered from a phone, and the demo keeps to that rule).
enum DemoData {
    private static var replyable: Bool { ProcessInfo.processInfo.arguments.contains("-squeak-demo-replyable") }

    private static func id(_ n: Int) -> String { String(format: "d0000000-0000-4000-8000-%012d", n) }

    static var snapshot: PhoneSnapshot {
        PhoneSnapshot(
            v: 1, mac: "Sibhi's MacBook", generatedAt: now(-4),
            duck: .init(blockedCount: 2, workingCount: 3),
            sessions: [
                .init(key: "pay", conductorSessionId: id(1), label: "storefront · Payment retry logic", agent: "claude",
                      state: replyable ? "finished" : "awaiting_input",
                      lastActivityAt: now(-120), detail: "How should temporary failures be retried?", git: "+84/−12 · 3 files", contextPercent: 41,
                      turnId: "t1",
                      message: "I added an idempotency check. One decision needs your input.\n\n**How should temporary failures be retried?**\n\n**A) Retry automatically.** 3 attempts with backoff.\n\n**B) Let the customer retry.** Keep checkout available.\n\nBoth prevent duplicate charges.",
                      choices: .init(question: "How should temporary failures be retried?",
                                     options: [.init(letter: "A", title: "Retry automatically — 3 attempts with backoff."),
                                               .init(letter: "B", title: "Let the customer retry — Keep checkout available.")],
                                     recommended: "A")),
                .init(key: "search", conductorSessionId: id(2), label: "atlas · Search index migration", agent: "codex", state: "awaiting_approval",
                      lastActivityAt: now(-300), detail: "Codex needs your permission to run a command", git: nil, contextPercent: nil,
                      turnId: nil, message: "Codex needs your permission to run a command", choices: nil),
                .init(key: "tg", conductorSessionId: id(3), label: "squeak · Telegram formatting", agent: "claude", state: "working",
                      lastActivityAt: now(-720), detail: "Running tests", git: "+311/−10 · 20 files", contextPercent: nil,
                      turnId: "t2", message: nil, choices: nil,
                      activity: .init(total: 17, steps: [
                          .init(kind: "note", text: "Checking why bold text arrives as literal asterisks."),
                          .init(kind: "tool", text: "Read tg-format.ts"),
                          .init(kind: "thinking", text: "The splitter cuts inside an open tag, so the retry falls back to plain text."),
                          .init(kind: "tool", text: "Edit tg-format.ts"),
                          .init(kind: "tool", text: "Running tests"),
                      ])),
                .init(key: "link", conductorSessionId: id(4), label: "compass · Onboarding deep link", agent: "codex", state: "working",
                      lastActivityAt: now(-1080), detail: "Editing 2 files", git: nil, contextPercent: 74,
                      turnId: "t3", message: nil, choices: nil,
                      activity: .init(total: 6, steps: [.init(kind: "tool", text: "Editing 2 files")])),
                .init(key: "cache", conductorSessionId: id(5), label: "atlas · API response caching", agent: "claude", state: "working",
                      lastActivityAt: now(-1620), detail: "Reading code", git: nil, contextPercent: nil,
                      turnId: "t4", message: nil, choices: nil,
                      activity: .init(total: 3, steps: [.init(kind: "tool", text: "Reading code")])),
                .init(key: "iso", conductorSessionId: id(6), label: "squeak · Session isolation checks", agent: "claude", state: "finished",
                      lastActivityAt: now(-3600), detail: "Each session now runs in its own worktree.", git: "+42/−3 · 2 files", contextPercent: nil,
                      turnId: "t5", message: "Each session now runs in its own worktree, and the checks fail loudly if two share one.", choices: nil),
                .init(key: "copy", conductorSessionId: id(7), label: "storefront · Checkout copy review", agent: "codex", state: "finished",
                      lastActivityAt: now(-7200), detail: "Reviewed the checkout copy.", git: nil, contextPercent: nil,
                      turnId: "t6", message: "Reviewed the checkout copy. Three strings were tightened.", choices: nil),
                .init(key: "idle", conductorSessionId: id(8), label: "compass · Release notes draft", agent: "claude", state: "idle",
                      lastActivityAt: now(-10800), detail: nil, git: nil, contextPercent: nil,
                      turnId: nil, message: nil, choices: nil),
            ])
    }

    /// A reply already sent from this phone, so the demo shows a "You" bubble.
    static var outbox: [String: [AppModel.SentMessage]] {
        ["pay": [.init(text: "Add retry handling for failed payments.\nPrevent duplicate charges.", date: Date().addingTimeInterval(-300), answersTurn: "t0")]]
    }

    private static func now(_ offset: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }
}
#endif
