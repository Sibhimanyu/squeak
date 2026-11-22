import Foundation
import Testing
@testable import SqueakMacCore

/// Answers each request from a script by method and path, and keeps what was asked.
private final class Script: HTTPTransport, @unchecked Sendable {
    private struct State { var queues: [String: [String]] = [:]; var requests: [HTTPRequest] = [] }
    private let state = NSLock()
    private nonisolated(unsafe) var box = State()
    var requests: [HTTPRequest] { state.withLock { box.requests } }
    func on(_ key: String, _ bodies: String...) { state.withLock { box.queues[key] = bodies } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let body: String = state.withLock {
            box.requests.append(request)
            var body = "{}"
            let key = "\(request.method) \(request.url.path)"
            if var q = box.queues[key], !q.isEmpty { body = q.count > 1 ? q.removeFirst() : q[0]; box.queues[key] = q }
            return body
        }
        return HTTPResponse(status: 200, body: Data(body.utf8))
    }
}

private func client(_ t: Script) -> PondsClient {
    PondsClient(host: NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, lineSource: { _ in AsyncThrowingStream { $0.finish() } }))
}

@Suite("Remote artifacts")
struct RemoteArtifactsTests {
    private let list = #"{"ready":true,"result":{"ownerName":"Sibhi","items":[{"path":"0123456789abcdef","name":"deck.pdf","kind":"pdf","source":"shown","modifiedAt":1700000000000,"size":2048,"duckName":"Pip"},{"nonsense":true}]}}"#

    @Test func theListIsAskedThenReadAndDecodedLeniently() async throws {
        let t = Script()
        t.on("POST /native/ponds/p1/artifacts", #"{"ready":false,"requestId":"r1","ownerName":"Sibhi"}"#)
        t.on("GET /native/ponds/p1/artifacts", #"{"ready":false}"#, list)
        let slept = SleepCount()
        let answer = try await RemoteArtifacts.waitForList(client(t), pond: "p1", sleep: { _ in await slept.add() })
        guard case .items(let items, let owner) = answer else { Issue.record("expected items"); return }
        #expect(owner == "Sibhi")
        #expect(items.count == 1 && items[0].name == "deck.pdf" && items[0].kind == .pdf && items[0].path == "0123456789abcdef")
        #expect(items[0].shown && items[0].size == 2048 && items[0].duckName == "Pip")
        #expect(await slept.n == 1)
        #expect(t.requests.last?.url.query == "request=r1")
        #expect(t.requests.allSatisfy { $0.headers["x-squeak-token"] == "tok" })
    }

    @Test func anOwnerWhoNeverAnswersIsOfflineNotAnError() async throws {
        let t = Script()
        t.on("POST /native/ponds/p1/artifacts", #"{"ready":false,"requestId":"r1"}"#)
        t.on("GET /native/ponds/p1/artifacts", #"{"ready":false}"#)
        let answer = try await RemoteArtifacts.waitForList(client(t), pond: "p1", wait: 3, every: 1, sleep: { _ in })
        #expect(answer == .pending)
        #expect(RemoteArtifacts.offline("Sibhi\u{2019}s Mac").contains("didn\u{2019}t answer"))
        #expect(RemoteArtifacts.fromLine("Sibhi\u{2019}s Mac") == "From Sibhi\u{2019}s Mac")
    }

    @Test func aFileReportsProgressThenTheCachedCopy() async throws {
        let t = Script()
        t.on("POST /native/ponds/p1/artifacts/fetch", #"{"ready":false,"requestId":"r2"}"#)
        t.on("GET /native/ponds/p1/artifacts/fetch",
             #"{"ready":false}"#,
             #"{"ready":false,"progress":{"have":1,"total":4}}"#,
             #"{"ready":true,"file":{"path":"/Users/me/cache/0123456789abcdef-deck.pdf","name":"deck.pdf","kind":"pdf","size":2048,"ownerName":"Sibhi"}}"#)
        let seen = Progress()
        let answer = try await RemoteArtifacts.waitForFile(client(t), pond: "p1", id: "0123456789abcdef", progress: { p in seen.add(p) }, sleep: { _ in })
        guard case .ready(let file) = answer else { Issue.record("expected the file"); return }
        #expect(file.path.hasSuffix("deck.pdf") && file.kind == .pdf && file.size == 2048 && file.ownerName == "Sibhi")
        #expect(seen.values == [nil, 0.25])
        let ask = t.requests.first { $0.method == "POST" }
        #expect(String(data: ask?.body ?? Data(), encoding: .utf8)?.contains("0123456789abcdef") == true)
    }

    @Test func aRefusalSaysWhy() async throws {
        let t = Script()
        t.on("POST /native/ponds/p1/artifacts/fetch", #"{"ready":false,"requestId":"r3"}"#)
        t.on("GET /native/ponds/p1/artifacts/fetch", #"{"ready":false,"error":"That file is too large to send (25 MB at most)."}"#)
        let answer = try await RemoteArtifacts.waitForFile(client(t), pond: "p1", id: "0123456789abcdef", sleep: { _ in })
        #expect(answer == .failed("That file is too large to send (25 MB at most)."))
    }

    @Test func aFileThatNeverMovesGivesUpAfterTheWait() async throws {
        let t = Script()
        t.on("POST /native/ponds/p1/artifacts/fetch", #"{"ready":false,"requestId":"r4"}"#)
        t.on("GET /native/ponds/p1/artifacts/fetch", #"{"ready":false}"#)
        let answer = try await RemoteArtifacts.waitForFile(client(t), pond: "p1", id: "0123456789abcdef", wait: 3, every: 1, sleep: { _ in })
        #expect(answer == .pending(progress: nil))
    }

    @Test func downloadingTextShowsPercentOnceItMoves() {
        #expect(RemoteArtifacts.downloading(nil) == "Asking \u{2026}")
        #expect(RemoteArtifacts.downloading(0.5) == "Downloading 50%")
        #expect(RemoteArtifacts.downloading(3) == "Downloading 100%")
    }
}

private actor SleepCount { var n = 0; func add() { n += 1 } }
private final class Progress: @unchecked Sendable {
    private let lock = NSLock()
    private nonisolated(unsafe) var all: [Double?] = []
    var values: [Double?] { lock.withLock { all } }
    func add(_ p: Double?) { lock.withLock { all.append(p) } }
}
