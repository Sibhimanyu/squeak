import Foundation
import SqueakMacCore

/// Made-up sessions for deterministic captures (SQUEAK_MAC_DEMO=1), matching the owner's reference
/// image. Nothing here touches the network, and `AppModel.send` refuses in demo mode.
enum DemoData {
    struct Bundle {
        var sessions: [HostSession]
        var needsYouText: [SessionKey: String]
    }

    static let question = """
    I found the retry path and added an idempotency check. One decision needs your input.

    How should temporary failures be retried?

    A. Retry automatically — Up to 3 attempts with exponential backoff. (Recommended)
    B. Let the customer retry — Show a clear error and keep checkout available.

    Both approaches prevent duplicate charges.
    """

    static func make(now: Date = Date()) -> Bundle {
        func s(_ id: String, _ provider: String, _ title: String, _ state: SessionState, min: Double, _ repo: String, _ branch: String, _ agent: String,
               approval: Bool = false) -> HostSession {
            var caps = Capabilities(readTranscript: .supported, send: .supported, activity: .supported)
            if provider == "conductor" { caps.openInHost = .supported }
            return HostSession(
                key: SessionKey(provider: provider, hostSessionId: id), title: title, repoName: repo, branch: branch,
                agent: agent, state: state, lastActivityAt: now.addingTimeInterval(-min * 60), alive: true, replyTarget: id,
                capabilities: caps, awaitingApproval: approval ? true : nil
            )
        }
        let pay = s("demo-1", "conductor", "Payment retry logic", .blocked, min: 2, "storefront", "payment-retries", "claude")
        let list = [
            pay,
            s("demo-2", "conductor", "Search index migration", .blocked, min: 5, "atlas", "search-migration", "codex", approval: true),
            s("demo-3", "conductor", "Telegram message formatting", .working, min: 12, "squeak", "telegram-formatting", "claude"),
            s("demo-4", "codex-terminal", "Fix onboarding deep link", .working, min: 18, "compass", "onboarding-link", "codex"),
            s("demo-5", "claude-desktop", "API response caching", .working, min: 27, "atlas", "api-caching", "claude"),
            s("demo-6", "conductor", "Session isolation checks", .finished, min: 60, "squeak", "session-isolation", "claude"),
            s("demo-7", "codex-desktop", "Native notifications", .finished, min: 120, "compass", "native-notifications", "codex"),
            s("demo-8", "claude-terminal", "CLI help cleanup", .finished, min: 180, "atlas", "cli-help", "claude"),
            s("demo-9", "conductor", "Flaky checkout test", .error, min: 45, "storefront", "checkout-flake", "codex"),
            s("demo-10", "conductor", "Untitled", .idle, min: 300, "compass", "release-notes", "claude"),
        ]
        return Bundle(sessions: list, needsYouText: [pay.key: question])
    }
}

// MARK: Transcripts for the conversation window

extension DemoData {
    /// Claude's reading is a few hours old, as it is unless Refresh was pressed; Codex's is live.
    static func usage(now: Date = Date()) -> UsageSnapshot {
        UsageSnapshot(
            claude: ProviderUsage(
                fiveHour: UsageWindow(usedPercent: 42, resetsAt: now.addingTimeInterval(2 * 3600 + 10 * 60)),
                longWindow: UsageWindow(usedPercent: 18, resetsAt: now.addingTimeInterval(4 * 86400 + 5 * 3600)),
                observedAt: now.addingTimeInterval(-3 * 3600)),
            codex: ProviderUsage(
                fiveHour: UsageWindow(usedPercent: 9, resetsAt: now.addingTimeInterval(3 * 3600 + 40 * 60)),
                longWindow: UsageWindow(usedPercent: 31, resetsAt: now.addingTimeInterval(5 * 86400)),
                observedAt: now.addingTimeInterval(-30)),
            todayCostUsd: 14.62, todayCostSessions: 6)
    }

    static func transcript(for key: SessionKey, now: Date = Date()) -> [ChatMessage] {
        func at(_ h: Int, _ m: Int) -> Date {
            Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: now) ?? now
        }
        func m(_ id: String, _ role: MessageRole, _ text: String, _ date: Date, state: MessageState? = nil) -> ChatMessage {
            ChatMessage(id: id, role: role, text: text, at: date, state: state)
        }
        if key.hostSessionId == "demo-1" {
            return [
                m("1", .user, "Add retry handling for failed payments. Keep duplicate charges from happening.", at(10, 41), state: .confirmed),
                m("2", .assistant, question, at(10, 44)),
            ]
        }
        if key.hostSessionId == "demo-3" {
            // A reply was just sent: the previous answer stays (muted), then "You", then the working row.
            return [
                m("1", .user, "Why does bold text show up as literal asterisks in Telegram?", at(10, 2), state: .confirmed),
                m("2", .assistant, "The splitter cuts messages inside an open tag, so Telegram rejects the markup and the retry falls back to plain text. I can fix the splitter and keep the fallback.", at(10, 9)),
                m("3", .user, "Fix the splitter, and make sure tables still render.", at(10, 12), state: .accepted(via: "conductor", delivery: .steered)),
                m("4", .user, "Also keep the plain-text fallback for anything it still can't parse.", at(10, 14), state: .accepted(via: "conductor", delivery: .queued)),
            ]
        }
        if key.hostSessionId == "demo-6" {
            return [
                m("1", .user, "Make sure two chats can never share a worktree. How did it go?", at(8, 52), state: .confirmed),
                m("2", .assistant, richMessage, at(9, 20)),
            ]
        }
        return [
            m("1", .user, "Where did we land on this?", at(9, 12), state: .confirmed),
            m("2", .assistant, "Done. The change is on the branch and the tests pass.", at(9, 20)),
        ]
    }

    static func activity(for key: SessionKey, now: Date = Date()) -> [ActivityStep] {
        func t(_ ago: Double) -> Date { now.addingTimeInterval(-ago) }
        switch key.hostSessionId {
        case "demo-3":
            return [
                ActivityStep(kind: "thinking", text: "Planning how to escape MarkdownV2 safely", at: t(240)),
                ActivityStep(kind: "tool", text: "Read src/utils/tg-format.ts", at: t(200)),
                ActivityStep(kind: "tool", text: "Edit src/utils/tg-format.ts", at: t(150)),
                ActivityStep(kind: "note", text: "Tables now render as aligned code blocks.", at: t(90)),
                ActivityStep(kind: "tool", text: "Run npm test -- tg-format", at: t(20)),
            ]
        case "demo-4":
            return [
                ActivityStep(kind: "tool", text: "Read DeepLinkRouter.swift", at: t(300)),
                ActivityStep(kind: "tool", text: "Edit DeepLinkRouter.swift", at: t(120)),
                ActivityStep(kind: "tool", text: "Edit OnboardingView.swift", at: t(60)),
            ]
        case "demo-5":
            return [
                ActivityStep(kind: "thinking", text: "Deciding which responses are safe to cache", at: t(400)),
                ActivityStep(kind: "tool", text: "Read src/api/cache.ts", at: t(80)),
            ]
        default: return []
        }
    }

    static func summary(for key: SessionKey) -> String? {
        key.hostSessionId == "demo-1" ? "3 files changed · 12 tests passed" : nil
    }
}

extension DemoData {
    /// One answer with every kind of block, for the typesetting captures.
    static let richMessage = """
    ## Session isolation

    Each chat now runs in **its own worktree**, and the check fails loudly if two chats ever share one. I touched `src/fleet/isolation.ts` and the launcher in ~/conductor/repos/squeak.

    The change is small, but it affects every place that creates a workspace. Two things are worth knowing:

    - The check runs *before* a chat starts
      - it compares the worktree path with every live chat
      - a clash stops the start and says which chat holds it
    - Archived workspaces are ignored, since their worktree is gone
    - [x] Unit tests for the clash case
    - [ ] A test for a path that is a symlink

    ### How it behaves

    | Case | Before | Now |
    | :--- | :---: | ---: |
    | Two chats, one worktree | silent clash | **refused** |
    | Archived workspace | counted | ignored |
    | Missing directory | crash | `error` card |

    The core of the check:

    ```ts
    export function assertIsolated(path: string, live: Chat[]): void {
      const clash = live.find((c) => c.worktree === path);
      if (clash) throw new Error(`worktree held by ${clash.title}`);
    }
    ```

    > Heads up: existing chats keep their worktree. The check only guards new starts, so a clash that already exists will not be repaired.

    1. Run `npm test` to see the new cases.
    2. Read the notes at [the design doc](https://example.com/docs/isolation) before changing the launcher.

    ---

    Say the word and I will cover the symlink case too.
    """
}
