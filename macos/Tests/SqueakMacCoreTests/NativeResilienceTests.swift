import Foundation
import Testing
@testable import SqueakMacCore

private final class Counting: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String] = []
    private var calls = 0
    private let handler: @Sendable (Int, HTTPRequest) throws -> HTTPResponse
    init(_ handler: @escaping @Sendable (Int, HTTPRequest) throws -> HTTPResponse) { self.handler = handler }
    var count: Int { lock.withLock { calls } }
    var requestPaths: [String] { lock.withLock { paths } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let n = lock.withLock { calls += 1; paths.append(request.url.path); return calls }
        return try handler(n, request)
    }
}

private func client(_ t: Counting) -> NativeHostClient {
    NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, sendRetryDelays: [0, 0])
}

private func row(_ seq: Int, _ kind: String, _ payload: String, role: String = "agent") -> NativeMessage {
    NativeMessage(seq: seq, role: role, kind: kind, payload: NativeJSON.parse(payload) ?? .null)
}

struct SendRetryTests {
    @Test func aRefusedConnectionIsTriedAgainTwiceThenGivesUp() async {
        let t = Counting { _, _ in throw TransportError.connectionRefused }
        await #expect(throws: NativeHostError.hostDown) { _ = try await client(t).send(id: "s", text: "x", mode: .queue) }
        #expect(t.count == 3)
    }

    @Test func aLaterTryThatGetsThroughSends() async throws {
        let t = Counting { n, _ in
            if n < 3 { throw TransportError.connectionRefused }
            return HTTPResponse(status: 200, body: Data(#"{"queued":false}"#.utf8))
        }
        #expect(try await client(t).send(id: "s", text: "x", mode: .queue) == false)
        #expect(t.count == 3)
    }

    @Test func aDroppedOrTimedOutSendIsNeverRepeated() async {
        for error in [TransportError.timedOut, .connectionLost] {
            let t = Counting { _, _ in throw error }
            await #expect(throws: (any Error).self) { _ = try await client(t).send(id: "s", text: "x", mode: .queue) }
            #expect(t.count == 1)
        }
    }

    @Test func anAnswerFromTheHostIsNeverRepeated() async {
        let t = Counting { _, _ in HTTPResponse(status: 500, body: Data(#"{"error":"boom"}"#.utf8)) }
        await #expect(throws: (any Error).self) { _ = try await client(t).send(id: "s", text: "x", mode: .queue) }
        #expect(t.count == 1)
    }
}

struct WarmAndEditsTests {
    @Test func warmPostsToTheRouteAndIgnoresA404() async {
        let t = Counting { _, _ in HTTPResponse(status: 404, body: Data(#"{"error":"not found"}"#.utf8)) }
        await client(t).warm(id: "s1")
        #expect(t.requestPaths == ["/native/sessions/s1/warm"])
    }

    @Test func warmGateCallsOncePerOpen() {
        var g = WarmGate()
        let a = SessionKey(provider: "claude-squeak", hostSessionId: "a")
        let b = SessionKey(provider: "claude-squeak", hostSessionId: "b")
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let first = g.shouldWarm(a, now: t0)
        let again = g.shouldWarm(a, now: t0.addingTimeInterval(5))
        let other = g.shouldWarm(b, now: t0.addingTimeInterval(6))
        let back = g.shouldWarm(a, now: t0.addingTimeInterval(7))
        let late = g.shouldWarm(a, now: t0.addingTimeInterval(7 + WarmGate.reopenAfter + 1))
        #expect(first && !again && other && back && late)
    }

    @Test func allowEditsSendsItsDecisionAndOnlyEditToolsOfferIt() async throws {
        let t = Counting { _, _ in HTTPResponse(status: 200, body: Data(#"{"ok":true}"#.utf8)) }
        try await client(t).allowEditsForChat(requestId: "r1")
        #expect(t.requestPaths == ["/native/requests/r1"])
        #expect(NativeCards.isEditTool("Edit") && NativeCards.isEditTool("Write"))
        #expect(!NativeCards.isEditTool("Bash") && !NativeCards.isEditTool(""))
    }

    @Test func anEditsRule() {
        #expect(NativeRule(id: "1", kind: "edits", value: "workspace").text == "File edits inside this workspace")
    }
}

struct RetryAndErrorTests {
    @Test func theLatestApiRetryIsOneLiveLine() {
        let rows = [
            row(1, "user/text", #"{"text":"go"}"#, role: "user"),
            row(2, "system/api_retry", #"{"attempt":3,"max_retries":10}"#, role: "system"),
            row(3, "system/api_retry", #"{"attempt":4,"max_retries":10}"#, role: "system"),
        ]
        let steps = NativeTranscript.map(rows).steps
        #expect(steps.filter { $0.kind == "retry" }.map(\.text) == ["Retrying… attempt 4 of 10"])
        #expect(ChatTimeline.workingLabel(steps) == "Retrying… attempt 4 of 10")
    }

    @Test func theNextAssistantMessageClearsIt() {
        let rows = [
            row(1, "user/text", #"{"text":"go"}"#, role: "user"),
            row(2, "system/api_retry", #"{"attempt":4,"max_retries":10}"#, role: "system"),
            row(3, "assistant", #"{"message":{"content":[{"type":"text","text":"Done."}]}}"#),
        ]
        let steps = NativeTranscript.map(rows).steps
        #expect(!steps.contains { $0.kind == "retry" })
        #expect(!ChatTimeline.workingLabel(steps).hasPrefix("Retrying"))
    }

    @Test func errorRowsGetFixedSentences() {
        #expect(NativeErrorText.sentence(#"{"type":"error","error":{"type":"overloaded_error"}}"#).contains("overloaded"))
        #expect(NativeErrorText.sentence("Credit balance is too low").hasPrefix("Out of credit"))
        #expect(NativeErrorText.sentence("429 rate_limit_error").hasPrefix("Hit a rate limit"))
        #expect(NativeErrorText.sentence(#"{"status":500,"body":"x"}"#) == "The request failed. Try again.")
        #expect(NativeErrorText.sentence("OpenCode 2 required") == "OpenCode 2 required")
        let stopped = NativeTranscript.map([row(1, "error", #"{"type":"error","content":"aborted by user"}"#)]).steps
        #expect(stopped.map(\.text) == ["Stopped"] && stopped.first?.kind == "note")
        let failed = NativeTranscript.map([row(1, "system/error", #"{"text":"{\"type\":\"error\"}"}"#, role: "system")]).steps
        #expect(failed.first?.kind == "error" && failed.first?.text == "The request failed. Try again.")
    }
}

struct NotifyGateAndWindowTests {
    @Test func notFrontmostAndOncePerRequest() {
        var g = NativeNotifyGate()
        let onScreen = g.admit(requestId: "r1", frontmost: true)
        let first = g.admit(requestId: "r1", frontmost: false)
        let dup = g.admit(requestId: "r1", frontmost: false)
        let next = g.admit(requestId: "r2", frontmost: false)
        let anon = g.admit(requestId: nil, frontmost: false)
        #expect(!onScreen && first && !dup && next && anon)
    }

    @Test func windowStartMovesBackToTheTurnsFirstRow() {
        let ids = ["u1", "a1", "a2", "a3", "u2", "b1"]
        let turns: [String?] = ["t1", "t1", "t1", "t1", "t2", "t2"]
        #expect(TranscriptWindow.startIndex(rowIDs: ids, start: "a2") == 2)
        #expect(TranscriptWindow.startIndex(rowIDs: ids, start: "a2", turnIDs: turns) == 0)
        #expect(TranscriptWindow.startIndex(rowIDs: ids, start: "u2", turnIDs: turns) == 4)
        #expect(TranscriptWindow.visible(rowIDs: ids, start: "a3", turnIDs: turns) == 0..<6)
        #expect(TranscriptWindow.startIndex(rowIDs: ids, start: "a2", turnIDs: [nil, nil, nil, nil, nil, nil]) == 2)
    }
}
