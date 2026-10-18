import Foundation
import SqueakMacCore

/// Made-up sessions for deterministic captures (SQUEAK_MAC_DEMO=1). Matches the v3 mockups.
/// Nothing here touches the network, and `AppModel.send` refuses in demo mode.
enum DemoData {
    struct Bundle {
        var sessions: [HostSession]
        var needsYouText: [SessionKey: String]
    }

    static func make(now: Date = Date()) -> Bundle {
        func s(_ id: String, _ title: String, _ state: SessionState, ago: TimeInterval, _ repo: String, _ branch: String, _ agent: String) -> HostSession {
            HostSession(
                key: SessionKey(provider: "conductor", hostSessionId: id), title: title, repoName: repo, branch: branch,
                agent: agent, state: state, lastActivityAt: now.addingTimeInterval(-ago), alive: true, replyTarget: id
            )
        }
        let checkout = s("demo-1", "Checkout retries", .blocked, ago: 20, "orchard", "main", "codex")
        var list = [
            checkout,
            s("demo-2", "Rate limiter", .working, ago: 120, "lighthouse", "fix/rate-window", "claude"),
            s("demo-3", "Fix flaky login test", .working, ago: 480, "squeak", "test/login-stability", "codex"),
            s("demo-4", "Docs refresh", .finished, ago: 720, "squeak", "docs/quickstart", "claude"),
            s("demo-5", "Migrate cache key", .finished, ago: 1440, "orchard", "chore/cache-key", "codex"),
        ]
        let earlier = ["Upgrade Swift toolchain", "Trim onboarding copy", "Debug webhook signature", "Index search results", "Rename billing module",
                       "Draft release notes", "Tidy CI matrix", "Profile cold start", "Port settings screen", "Audit dependencies",
                       "Fix date parsing", "Sketch export flow"]
        for (i, t) in earlier.enumerated() {
            list.append(s("demo-e\(i)", t, i % 3 == 0 ? .idle : .finished, ago: 86400 * Double(2 + i), "orchard", "chore/\(i)", i % 2 == 0 ? "claude" : "codex"))
        }
        let text = "I traced the failures to the gateway.\n\nShould I retry card declines, or stop after one attempt?\n\nA. Retry once\nB. Stop\n"
        return Bundle(sessions: list, needsYouText: [checkout.key: text])
    }
}

// MARK: Transcripts for the conversation window

extension DemoData {
    /// A made-up conversation per demo session; every chat but the first is short.
    static func transcript(for key: SessionKey, now: Date = Date()) -> [ChatMessage] {
        func m(_ id: String, _ role: MessageRole, _ text: String, ago: TimeInterval, state: MessageState? = nil) -> ChatMessage {
            ChatMessage(id: id, role: role, text: text, at: now.addingTimeInterval(-ago), state: state)
        }
        if key.hostSessionId == "demo-1" {
            let question = make(now: now).needsYouText[key] ?? ""
            return [
                m("1", .user, "are we correctly backing off between retries?", ago: 1320, state: .confirmed),
                m("2", .assistant, """
                ## Checkout retry investigation

                I looked through the **checkout client** and traced the retry flow. We are backing off between retries using exponential backoff with jitter, but I found a couple of issues worth addressing:

                - The backoff is correctly applied between attempts
                - Jitter is added (±20%) to avoid thundering herd
                - The retry budget isn't being decremented in one early return path
                - We should cap the maximum delay to avoid overly long waits

                Here's the relevant logic in the checkout client:

                ```swift
                if retryCount < maxRetries {
                    scheduleRetry()
                }
                ```

                I'll update the early return path to decrement the retry budget and add a max delay cap, then run the focused tests.
                """, ago: 1260),
                m("3", .user, "sounds good, please go ahead", ago: 900, state: .accepted(via: "conductor")),
                m("4", .assistant, question, ago: 20),
            ]
        }
        return [
            m("1", .user, "where did we land on this?", ago: 3600, state: .confirmed),
            m("2", .assistant, "Done. The change is on the branch and the tests pass.", ago: 3500),
        ]
    }

    static func activity(for key: SessionKey, now: Date = Date()) -> [ActivityStep] {
        guard key.hostSessionId == "demo-2" else { return [] }
        return [
            ActivityStep(kind: "thinking", text: "Planning where the window should reset"),
            ActivityStep(kind: "tool", text: "Read src/limiter/window.ts"),
            ActivityStep(kind: "tool", text: "Edit src/limiter/window.ts"),
            ActivityStep(kind: "text", text: "The bucket resets on the wrong boundary; fixing it."),
            ActivityStep(kind: "tool", text: "Run npm test -- limiter"),
        ]
    }
}
