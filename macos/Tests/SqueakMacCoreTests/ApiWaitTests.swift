import Foundation
import Testing
@testable import SqueakMacCore

/// The honest status while a request is out, the dock's words for it, and the notices above the composer.
@Suite struct ApiWaitTests {
    private func phase(_ phase: String, label: String? = nil) -> NativeEvent {
        var o: [String: NativeJSON] = ["type": .string("squeak_phase"), "phase": .string(phase)]
        if let label { o["label"] = .string(label) }
        return .delta(.object(o))
    }

    @Test func aWaitNoticeIsTheLiveStepNeverThinking() {
        var live = NativeLiveState()
        _ = live.apply(.status("working"))
        _ = live.apply(phase("waiting", label: "Waiting for Claude · 4m"))
        #expect(live.liveStep == ActivityStep(kind: "waiting", text: "Waiting for Claude · 4m"))
        // the minute ticking redraws the same step in place
        _ = live.apply(phase("waiting", label: "Waiting for Claude · 5m"))
        #expect(live.liveStep?.text == "Waiting for Claude · 5m")
        _ = live.apply(phase("retrying", label: "Retrying Claude (2) · 5m"))
        #expect(live.liveStep?.text == "Retrying Claude (2) · 5m")
    }

    @Test func theFirstStreamEventEndsTheWaitThenThinkingMayShow() {
        var live = NativeLiveState()
        _ = live.apply(phase("waiting", label: "Waiting for Claude"))
        _ = live.apply(phase("none"))
        #expect(live.liveStep == nil)
        _ = live.apply(.delta(.object(["type": .string("stream_event"), "event": .object(["type": .string("message_start")])])))
        #expect(live.liveStep == ActivityStep(kind: "thinking", text: "Thinking…"))
    }

    @Test func aWaitNoticeNeverTouchesTheStreamingText() {
        var live = NativeLiveState()
        _ = live.apply(.delta(.object(["type": .string("stream_event"),
                                       "event": .object(["type": .string("content_block_delta"),
                                                         "delta": .object(["type": .string("text_delta"), "text": .string("hi")])])])))
        _ = live.apply(phase("waiting", label: "Waiting for Claude"))
        #expect(live.streamingText == "hi")
    }

    @Test func theDockSaysWaitingInsteadOfWorking() {
        let steps = [ActivityStep(kind: NativeLiveState.waitingKind, text: "Waiting for Claude · 4m")]
        #expect(NativeLiveState.waitingLine(steps) == "Waiting for Claude · 4m")
        #expect(ChatIndicator.working.line(workingLabel: "Thinking", model: "Opus 5.5", waiting: "Waiting for Claude · 4m") == "Waiting for Claude · 4m · Opus 5.5")
        #expect(ChatIndicator.working.line(workingLabel: "Thinking", model: nil, waiting: nil) == "Working…")
        // only the working indicator is replaced
        #expect(ChatIndicator.waitingApproval.line(workingLabel: "x", model: nil, waiting: "Waiting for Claude") == "Waiting for you to allow a command")
    }

    @Test func aWaitingStepIsATransientPlaceholderInTheFeed() {
        var m = ActivityFeedMerge()
        let tool = ActivityStep(kind: "tool", text: "Read a.swift", toolId: "a")
        let wait = ActivityStep(kind: NativeLiveState.waitingKind, text: "Waiting for Claude")
        #expect(m.apply(incoming: [tool], live: wait, working: true, turn: "t").steps.last == wait)
        #expect(m.apply(incoming: [tool], live: nil, working: true, turn: "t").steps == [tool])
    }

    @Test func noticesShowOnlyWhenTheHostSaysAndTheChatIsIdle() {
        var s = HostSession(key: SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: "squeak-native:1"), state: .finished)
        #expect(!NativeChatNotice.showsLarge(s))
        s.largeChat = true
        #expect(NativeChatNotice.showsLarge(s))
        s.state = .working
        #expect(!NativeChatNotice.showsLarge(s))
        s.state = .error
        s.retryable = true
        #expect(NativeChatNotice.showsRetry(s))
        s.state = .finished
        #expect(!NativeChatNotice.showsRetry(s))
        #expect(NativeChatNotice.largeText == "This chat is very large — replies will be slow and may fail.")
        #expect(NativeChatNotice.continueTitle == "Continue in a new thread")
    }

    @Test func theHostsLargeAndRetryableReachTheSession() throws {
        let json = #"{"id":"a","status":"error","large":{"reason":"context","transcriptBytes":1},"retryable":true}"#
        let s = try JSONDecoder().decode(NativeSession.self, from: Data(json.utf8))
        #expect(s.isLarge && s.retryable)
        let mapped = NativeAdapter.map(s, overlay: nil)
        #expect(mapped.largeChat == true && mapped.retryable == true)
        let plain = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"b","status":"idle"}"#.utf8))
        #expect(!plain.isLarge && !plain.retryable)
    }
}
