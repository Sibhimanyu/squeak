import Foundation
import Testing
@testable import SqueakMacCore

private final class Recorder: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private nonisolated(unsafe) var seen: [HTTPRequest] = []
    var requests: [HTTPRequest] { lock.withLock { seen } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { seen.append(request) }
        return HTTPResponse(status: 200, body: Data("{\"ok\":true}".utf8))
    }
}

@Suite("Show requests")
struct ShowRequestsTests {
    /// The live shape: `event: open` with the host's JSON (a duck's worktree path under .context).
    private let frame = #"{"id":"r1","sessionId":"3e4619f7-d6db-4fb9-a8e3-a0c54e90556a","projectId":"p1","path":"/Users/x/squeak/workspaces/heresay/w/.context/simpler-widget/preview.html","relative":".context/simpler-widget/preview.html","title":null}"#

    @Test func openFramesBecomeRequestsAndHelloIsIgnored() async {
        let lines: @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> = { req in
            #expect(req.url.path == "/native/show-requests/stream")
            return AsyncThrowingStream { c in
                for l in ["event: hello", "data: {}", "", "event: open", "data: \(frame)", "", "event: open", "data: {\"id\":\"\"}", ""] { c.yield(l) }
                c.finish()
            }
        }
        let host = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: Recorder(), tokenProvider: { "tok" }, lineSource: lines)
        var seen: [ShowRequest] = []
        for await r in host.showRequests(sleep: { _ in throw CancellationError() }) { seen.append(r) }
        #expect(seen.count == 1)
        #expect(seen[0].id == "r1")
        #expect(seen[0].sessionId == "3e4619f7-d6db-4fb9-a8e3-a0c54e90556a")
        #expect(seen[0].path.hasSuffix("/.context/simpler-widget/preview.html"))
    }

    @Test func ackPostsTheOutcome() async throws {
        let t = Recorder()
        let host = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, lineSource: { _ in AsyncThrowingStream { $0.finish() } })
        await host.ackShow(id: "r1", outcome: .opened)
        await host.ackShow(id: "r2", outcome: .refused("That chat is not here."))
        let reqs = t.requests
        #expect(reqs.map(\.url.path) == ["/native/show-requests/r1/ack", "/native/show-requests/r2/ack"])
        let b1 = try JSONDecoder().decode(NativeJSON.self, from: reqs[0].body ?? Data())
        let b2 = try JSONDecoder().decode(NativeJSON.self, from: reqs[1].body ?? Data())
        #expect(b1["ok"]?.bool == true)
        #expect(b2["ok"]?.bool == false)
        #expect(b2["message"]?.string == "That chat is not here.")
    }

    @Test func planUsesTheChatsFolderOrTheFullPathOrRefuses() {
        let cwd = "/Users/x/squeak/workspaces/heresay/w"
        #expect(ShownFilePlan.make(path: cwd + "/.context/a/preview.html", cwd: cwd, exists: true) == .open(tab: ".context/a/preview.html"))
        #expect(ShownFilePlan.make(path: "/tmp/shot.png", cwd: cwd, exists: true) == .open(tab: "/tmp/shot.png"))
        if case .refuse(let why) = ShownFilePlan.make(path: cwd + "/gone.png", cwd: cwd, exists: false) { #expect(why.contains("gone.png")) } else { Issue.record("expected refusal") }
    }
}
