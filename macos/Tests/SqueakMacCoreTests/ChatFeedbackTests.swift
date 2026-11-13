import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Chat feedback")
struct ChatFeedbackTests {
    // MARK: Indicator

    @Test func indicatorTextPerState() {
        func r(_ state: SessionState, approval: Bool = false, bg: Int = 0, waiting: Bool = false, sending: Bool = false) -> ChatIndicator {
            ChatIndicator.resolve(state: state, awaitingApproval: approval, backgroundCount: bg, backgroundWaiting: waiting, sending: sending)
        }
        #expect(r(.idle, sending: true).text == "Sending…")
        #expect(r(.working).text == "Working…")
        #expect(r(.blocked, approval: true).text == "Waiting for you to allow a command")
        #expect(r(.finished, bg: 2).text == "Waiting for 2 background tasks")
        #expect(r(.working, bg: 1, waiting: true).text == "Waiting for 1 background task")
        #expect(r(.finished) == .idle && r(.finished).text == nil && !r(.idle).isActive)
        // A turn that is running with subagents is plain working; a question card speaks for itself.
        #expect(r(.working, bg: 3) == .working)
        #expect(r(.blocked) == .idle)
        #expect(r(.error, bg: 1) == .idle)
    }

    // MARK: Local echo

    @Test func localEchoShowsAtOnceAndMergesWhenTheHostShowsIt() async {
        let s = makeSession("n1", provider: "claude-squeak")
        let a = FakeAdapter(sessions: [s])
        let clock = FakeClock()
        let broker = Broker(adapters: [a], clock: clock)
        await broker.refresh()
        await broker.setFocused(s.key)
        let id = UUID()
        _ = await broker.send("hello there", to: s.key, clientId: id)
        let echo = await broker.messages(for: s.key)
        #expect(echo.count == 1 && echo[0].role == .user && echo[0].text == "hello there")
        // The row is an optimistic working state until the host answers.
        #expect(ChatTimeline.isWorking(messages: echo, state: .idle, now: clock.now()))

        await a.setTranscript([ChatMessage(id: "h1", role: .user, text: "hello there", at: clock.now(), turnId: "T1")])
        await broker.refreshTranscript()
        let merged = await broker.messages(for: s.key)
        #expect(merged.map(\.id) == ["h1"])
        #expect(merged[0].state == .confirmed && merged[0].clientId == id)
    }

    // MARK: Live step

    private func streamStart(_ block: [String: NativeJSON]) -> NativeEvent {
        .delta(.object(["type": .string("stream_event"),
                        "event": .object(["type": .string("content_block_start"), "content_block": .object(block)])]))
    }

    @Test func aThinkingOrToolStartIsALiveStepBeforeAnyRow() {
        var live = NativeLiveState()
        _ = live.apply(.status("working"))
        #expect(live.liveStep?.kind == "thinking")
        _ = live.apply(streamStart(["type": .string("thinking")]))
        #expect(live.liveStep == ActivityStep(kind: "thinking", text: "Thinking…"))
        _ = live.apply(streamStart(["type": .string("tool_use"), "id": .string("t1"), "name": .string("Agent")]))
        #expect(live.liveStep?.kind == "tool" && live.liveStep?.toolId == "t1")
        let row = NativeMessage(seq: 5, role: "agent", kind: "assistant", payload: .object([:]), createdAt: Date())
        _ = live.apply(.message(row))
        #expect(live.liveStep == nil)
        _ = live.apply(streamStart(["type": .string("thinking")]))
        _ = live.apply(.status("idle"))
        #expect(live.liveStep == nil)
    }

    @Test func withLiveShowsTheLiveStepOnlyWhileItIsNotInTheFeedYet() {
        let tool = ActivityStep(kind: "tool", text: "Starting a duckling", toolId: "t1")
        let persisted = [ActivityStep(kind: "tool", text: "Start restyle", toolId: "t1")]
        #expect(NativeLiveState.withLive([], live: tool, working: true) == [tool])
        #expect(NativeLiveState.withLive(persisted, live: tool, working: true) == persisted)
        #expect(NativeLiveState.withLive([], live: tool, working: false).isEmpty)
    }

    // MARK: Requests

    @Test func resetAndReconnectClearStaleRequests() {
        var live = NativeLiveState()
        let old = NativeRequest(id: "old", kind: "tool", payload: .null, createdAt: Date(timeIntervalSince1970: 100))
        _ = live.apply(.request(old))
        #expect(live.requests.count == 1)
        #expect(live.apply(.connected) == .refetch)
        #expect(live.requests.isEmpty)
        _ = live.apply(.request(old))
        _ = live.apply(.reset(lastSeq: 0, prunedThrough: 0))
        #expect(live.requests.isEmpty)
    }

    @Test func newestRequestWinsAndRefetchWhenStatusNeedsYouWithNoCard() {
        let a = NativeRequest(id: "a", kind: "tool", payload: .null, createdAt: Date(timeIntervalSince1970: 10))
        let b = NativeRequest(id: "b", kind: "tool", payload: .null, createdAt: Date(timeIntervalSince1970: 20))
        let c = NativeRequest(id: "c", kind: "tool", payload: .null)
        #expect(NativeCards.newest(of: [b, a])?.id == "b")
        #expect(NativeCards.newest(of: [a, b, c])?.id == "c")
        #expect(NativeLiveState.needsRequestRefetch(status: "needs_user_permission", hasCard: false))
        #expect(NativeLiveState.needsRequestRefetch(status: "needs_plan_response", hasCard: false))
        #expect(!NativeLiveState.needsRequestRefetch(status: "needs_user_permission", hasCard: true))
        #expect(!NativeLiveState.needsRequestRefetch(status: "working", hasCard: false))
        var live = NativeLiveState()
        live.replaceRequests([a, b])
        #expect(live.requests.map(\.id) == ["a", "b"])
    }

    // MARK: Rows once

    @Test func rowsAreComputedOncePerChange() {
        let cache = ChatRowsCache()
        let m = [ChatMessage(id: "1", role: .user, text: "hi"), ChatMessage(id: "2", role: .assistant, text: "yo")]
        for _ in 0..<8 { _ = cache.rows(messages: m, state: .idle) }
        #expect(cache.computeCount == 1)
        _ = cache.rows(messages: m + [ChatMessage(id: "3", role: .user, text: "more")], state: .idle)
        #expect(cache.computeCount == 2)
        _ = cache.rows(messages: m, state: .working)
        #expect(cache.computeCount == 3)
        // The working row belongs to the dock.
        #expect(cache.rows(messages: m, state: .working).allSatisfy { if case .working = $0 { false } else { true } })
    }

    // MARK: Coalescing

    @Test func streamedTextIsPublishedAtMostAboutFifteenTimesASecond() {
        var gate = PublishGate()
        let t0 = Date(timeIntervalSince1970: 1_000)
        var admitted = 0
        for i in 0..<100 where gate.admit(now: t0.addingTimeInterval(Double(i) * 0.01)) { admitted += 1 }
        // 100 deltas over one second: first plus one per 1/15 s.
        #expect(admitted >= 14 && admitted <= 16)
        let forced = gate.admit(now: t0.addingTimeInterval(1.0), force: true)
        #expect(forced)
        #expect(gate.wait(now: t0.addingTimeInterval(1.0)) > 0.06)
    }

    // MARK: Grouping

    @Test func consecutiveToolRowsSitCloseAndKindChangesBreathe() {
        let tool = { (id: String) in TurnItem.tool(id: id, preview: ToolCallLabel.preview("Read a.swift"), running: false, detail: nil) }
        let think = TurnItem.thinking(id: "t", text: "x", seconds: 3, live: false)
        let entries = TurnLayout.entries([think, tool("a"), tool("b"), tool("c"), think2()])
        #expect(entries.map(\.gap) == [0, ChatSpacing.kindChange, ChatSpacing.toolToTool, ChatSpacing.toolToTool, ChatSpacing.kindChange])
        #expect(ChatSpacing.toolToTool >= 2 && ChatSpacing.toolToTool <= 4)
        #expect(ChatSpacing.kindChange >= 8 && ChatSpacing.turnToMessage <= 12 && ChatSpacing.messageToMessage <= 12)
        #expect(ChatSpacing.gap(from: nil, to: .tool) == 0)
        #expect(ChatSpacing.gap(from: .message, to: .tool) == ChatSpacing.turnToMessage)
    }

    private func think2() -> TurnItem { .thinking(id: "t2", text: "", seconds: nil, live: true) }

    @Test func thinkingCollapsesToOneLine() {
        #expect(TurnLayout.thinkingTitle(seconds: 3, live: false) == "Thought for 3s")
        #expect(TurnLayout.thinkingTitle(seconds: nil, live: false) == "Thought")
        #expect(TurnLayout.thinkingTitle(seconds: 9, live: true) == "Thinking…")
    }

    // MARK: Errors

    @Test func hostErrorsNeverReadInternalError() {
        #expect(ChatErrorText.hostSentence(status: 500, message: "internal error") == ChatErrorText.generic)
        #expect(ChatErrorText.hostSentence(status: 500, message: nil) == ChatErrorText.generic)
        #expect(ChatErrorText.hostSentence(status: 500, message: "Error: Internal Server Exception at x") == ChatErrorText.generic)
        #expect(ChatErrorText.hostSentence(status: 409, message: "can't steer") == "can't steer")
        #expect(NativeHostError.http(500, "internal error").reason == ChatErrorText.generic)
        #expect(NativeHostError.http(409, "turn that asked is gone").reason == "turn that asked is gone")
    }

    // MARK: Host fields

    @Test func sessionDecodesBackgroundAndWaitingOptionally() throws {
        let with = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"a","status":"waiting","background":{"count":3}}"#.utf8))
        #expect(with.backgroundCount == 3)
        let mapped = NativeAdapter.map(with, overlay: nil)
        #expect(mapped.state == .working && mapped.backgroundWaiting == true && mapped.backgroundCount == 3)
        let without = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"b","status":"idle"}"#.utf8))
        #expect(without.backgroundCount == nil)
        #expect(NativeAdapter.map(without, overlay: nil).backgroundWaiting == nil)
    }
}
