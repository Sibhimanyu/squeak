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
        #expect(w.tick(at: t0.addingTimeInterval(4)) == .none)
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
