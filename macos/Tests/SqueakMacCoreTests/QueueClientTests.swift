import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Queued messages")
struct QueueClientTests {
    private func client(_ t: QueueStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }

    @Test func readsTheQueueOldestFirstAndMapsSteer() async throws {
        let t = QueueStub(status: 200, body: #"{"items":[{"id":"b","text":"two","mode":"steer","position":2},{"id":"a","text":"one","mode":"queue","position":1},{"text":"no id"}]}"#)
        // The id-less row makes the whole body unreadable rather than guessing.
        await #expect(throws: (any Error).self) { _ = try await client(t).queue(sessionId: "c1") }
        let ok = QueueStub(status: 200, body: #"{"items":[{"id":"b","text":"two","mode":"steer","position":2},{"id":"a","text":"one","mode":"queue","position":1}]}"#)
        let items = try await client(ok).queue(sessionId: "c1")
        #expect(items?.map(\.id) == ["a", "b"])
        #expect(items?.map(\.isSteer) == [false, true])
        #expect(ok.requests.last?.method == "GET" && ok.requests.last?.url.path.hasSuffix("/c1/queue") == true)
    }

    @Test func olderDaemonOrUnreadableQueueIsNil() async throws {
        #expect(try await client(QueueStub(status: 404, body: "")).queue(sessionId: "c1") == nil)
        #expect(try await client(QueueStub(status: 503, body: "")).queue(sessionId: "c1") == nil)
    }

    @Test func promoteAndCancelPostOnceAndMapOutcomes() async {
        let ok = QueueStub(status: 200, body: #"{"ok":true}"#)
        #expect(await client(ok).promoteQueued(sessionId: "c1", messageId: "m_1") == .done)
        #expect(ok.requests.count == 1)
        #expect(ok.requests[0].method == "POST" && ok.requests[0].url.path.hasSuffix("/c1/queue/m_1/promote"))
        #expect(await client(ok).cancelQueued(sessionId: "c1", messageId: "m_1") == .done)
        #expect(ok.requests.last?.url.path.hasSuffix("/queue/m_1/cancel") == true)

        let gone = QueueStub(status: 404, body: #"{"ok":false,"reason":"That message already went to the agent."}"#)
        #expect(await client(gone).promoteQueued(sessionId: "c1", messageId: "m_1") == .alreadySent)
        let old = QueueStub(status: 404, body: "not found")
        if case .failed(let reason) = await client(old).promoteQueued(sessionId: "c1", messageId: "m_1") {
            #expect(reason.contains("Update"))
        } else { Issue.record("expected failed") }
        let refused = QueueStub(status: 409, body: #"{"ok":false,"reason":"Conductor didn't take that change."}"#)
        #expect(await client(refused).cancelQueued(sessionId: "c1", messageId: "m_1") == .failed(reason: "Conductor didn't take that change."))
    }

    @Test func aBadMessageIdIsNeverSent() async {
        let t = QueueStub(status: 200, body: #"{"ok":true}"#)
        if case .failed = await client(t).promoteQueued(sessionId: "c1", messageId: "../x") {} else { Issue.record("expected failed") }
        #expect(t.requests.isEmpty)
    }
}

private final class QueueStub: HTTPTransport, @unchecked Sendable {
    let status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int, body: String) { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}
