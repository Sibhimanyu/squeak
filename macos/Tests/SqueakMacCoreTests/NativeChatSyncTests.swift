import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct NativeChatSyncTests {
    private func host(_ lines: @escaping @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error>) -> NativeHostClient {
        NativeHostClient(
            baseURL: URL(string: "http://127.0.0.1:8479")!, transport: SyncStub(), tokenProvider: { "tok" }, lineSource: lines)
    }

    private static func msg(_ seq: Int) -> [String] {
        ["event: message", #"data: {"seq":\#(seq),"role":"agent","kind":"assistant","payload":{}}"#, ""]
    }

    @Test func silentStreamIsDroppedAndReconnectedWithMissedMessages() async {
        let attempt = Box(0)
        let opened = Box<[String]>([])
        let h = host { req in
            opened.current.append(req.url.absoluteString)
            attempt.current += 1
            let n = attempt.current
            return AsyncThrowingStream { c in
                if n == 1 {
                    for l in Self.msg(1) { c.yield(l) }  // then silence: never ends
                } else {
                    for l in ["event: status", #"data: {"status":"idle"}"#, ""] + Self.msg(2) { c.yield(l) }
                }
            }
        }
        var seen: [NativeEvent] = []
        for await e in h.stream(id: "s", after: 0, idleTimeout: .milliseconds(80), sleep: { _ in await Task.yield() }) {
            seen.append(e)
            if case .message(let m) = e, m.seq == 2 { break }
        }
        #expect(seen.contains(.connected))
        #expect(opened.current[1].hasSuffix("/stream?after=1"))
        let seqs = seen.compactMap { e -> Int? in if case .message(let m) = e { return m.seq } else { return nil } }
        #expect(seqs == [1, 2])
    }

    @Test func backoffStartsAtHalfASecondAndCapsAtFive() {
        var b = Duration.milliseconds(500)
        var steps: [Duration] = []
        for _ in 0..<5 { steps.append(b); b = min(.seconds(5), b * 2) }
        #expect(steps == [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(5)])
    }

    @Test func sendWithoutEventsForcesReconnectOnce() {
        var w = NativeSyncWatchdog()
        let t0 = Date()
        w.noteSend(at: t0)
        #expect(w.tick(at: t0.addingTimeInterval(2)) == .none)
        #expect(w.tick(at: t0.addingTimeInterval(3.1)) == .reconnect)
        #expect(w.tick(at: t0.addingTimeInterval(4)) == .none)
    }

    @Test func anEventAfterTheSendSilencesTheWatchdog() {
        var w = NativeSyncWatchdog()
        let t0 = Date()
        w.noteSend(at: t0)
        w.noteEvent(at: t0.addingTimeInterval(1))
        #expect(w.tick(at: t0.addingTimeInterval(4)) == .poll) // no reconnect; the fast poll asks the host instead
    }

    @Test func workingChatPollsEveryTenSecondsAndMismatchIsSpotted() {
        var w = NativeSyncWatchdog()
        let t0 = Date()
        w.noteReconnect(at: t0)
        w.noteStatus("working")
        #expect(w.tick(at: t0.addingTimeInterval(9)) == .none)
        #expect(w.tick(at: t0.addingTimeInterval(10)) == .poll)
        #expect(w.tick(at: t0.addingTimeInterval(15)) == .none)
        #expect(NativeSyncWatchdog.mismatch(hostStatus: "idle", hostLastSeq: 5, status: "working", lastSeq: 4))
        #expect(!NativeSyncWatchdog.mismatch(hostStatus: "idle", hostLastSeq: 5, status: "idle", lastSeq: 5))
        var idle = NativeSyncWatchdog()
        idle.noteStatus("idle")
        #expect(idle.tick(at: t0.addingTimeInterval(60)) == .none)
    }

    @Test func seqMergeNeverDuplicates() throws {
        func m(_ seq: Int) throws -> NativeMessage {
            try JSONDecoder().decode(NativeMessage.self, from: Data(#"{"seq":\#(seq),"role":"agent","kind":"assistant","payload":{}}"#.utf8))
        }
        let merged = NativeSeqMerge.merge([try m(1), try m(2)], with: [try m(2), try m(3)])
        #expect(merged.map(\.seq) == [1, 2, 3])
    }
}

private struct SyncStub: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { HTTPResponse(status: 200, body: Data("{}".utf8)) }
}

struct StuckChatTests {
    @Test func theWorkingLineDrawsFromTheHostsOwnWord() {
        func shows(_ status: String?, bg: Int? = nil, optimistic: Bool = false) -> Bool {
            ChatLiveness.showsWorkingLine(indicatorActive: false, isWorking: false, hostStatus: status, backgroundCount: bg, optimistic: optimistic)
        }
        #expect(shows("working") && shows("busy") && shows("needs_user_permission") && shows("needs_user_input"))
        #expect(shows("idle", bg: 1) && shows("idle", optimistic: true))
        #expect(!shows("idle") && !shows(nil) && !shows("idle", bg: 0) && !shows("error"))
    }

    @Test func afterASendThePollIsFastUntilTheFirstAgentRow() {
        var w = NativeSyncWatchdog()
        let t0 = Date(timeIntervalSince1970: 1_000)
        w.noteReconnect(at: t0)
        w.noteSend(at: t0)
        w.noteEvent(at: t0.addingTimeInterval(1))
        #expect(w.tick(at: t0.addingTimeInterval(2.5)) == .none)
        #expect(w.tick(at: t0.addingTimeInterval(3.1)) == .poll)
        #expect(w.tick(at: t0.addingTimeInterval(6.2)) == .poll)
        w.noteAgentRow()
        #expect(w.tick(at: t0.addingTimeInterval(9.5)) == .none)
        #expect(w.tick(at: t0.addingTimeInterval(16.5)) == .poll)
    }

    @Test func aStatusFromBeforeOurOwnRowNeverEndsTheOptimism() {
        var w = OptimisticWork()
        let t0 = Date()
        w.begin(at: t0, baselineSeq: 10)
        w.observe(status: .idle)
        w.observe(status: .error)
        #expect(w.resolve(host: .idle, now: t0.addingTimeInterval(1)) == .working)
        w.observe(message: 11, role: .user)
        w.observe(status: .idle)
        #expect(!w.isStarted)
    }
}
