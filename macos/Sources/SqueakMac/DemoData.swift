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
        ]
        return Bundle(sessions: list, needsYouText: [pay.key: question])
    }
}

// MARK: Transcripts for the conversation window

extension DemoData {
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
