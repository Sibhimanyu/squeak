import Foundation
import Testing
@testable import SqueakMacCore

private final class Replier: HTTPTransport, @unchecked Sendable {
    var last: HTTPRequest?
    let status: Int, reply: String
    init(_ reply: String, status: Int = 200) { self.reply = reply; self.status = status }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        last = request
        return HTTPResponse(status: status, body: Data(reply.utf8))
    }
}

@Suite struct HostPondChangesTests {
    private static let json = #"""
    {"projectId":"p1",
     "main":{"branch":"main","base":null,"truncated":false,"totals":{"added":1,"removed":1,"files":1},
             "files":[{"path":"a.txt","status":"M","added":1,"removed":1}]},
     "ducks":[
       {"duckId":"d1","duckName":"Pip","colourSeed":"s1","duty":"on","branch":"sq/pip","workspaceId":"w1","base":"abc","truncated":true,
        "totals":{"added":9,"removed":0,"files":5},
        "files":[{"path":"a.txt","status":"M","added":1,"removed":0},{"path":"new.txt","status":"A","added":2,"removed":0,"untracked":true},{"nope":1}]},
       {"duckId":"d2","duckName":"Moss","duty":"off","branch":"sq/moss","workspaceId":"w2","files":[],"totals":{"added":0,"removed":0,"files":0},"truncated":false},
       {"duckName":"no id"}],
     "ducksTruncated":false}
    """#

    @Test func decodesGroupsLeniently() throws {
        let r = try JSONDecoder().decode(HostPondChanges.self, from: Data(Self.json.utf8))
        #expect(r.projectId == "p1" && !r.ducksTruncated)
        #expect(r.main?.branch == "main" && r.main?.changes.files.map(\.path) == ["a.txt"])
        #expect(r.main?.changes.added == 1 && r.main?.changes.removed == 1)
        #expect(r.ducks.map(\.duckName) == ["Pip", "Moss"])
        let pip = r.ducks[0]
        #expect(pip.branch == "sq/pip" && pip.workspaceId == "w1" && pip.onDuty && pip.changes.base == "abc")
        #expect(pip.changes.files.map(\.path) == ["a.txt", "new.txt"])
        #expect(pip.changes.files[1].status == "A" && pip.changes.files[1].untracked)
        #expect(pip.changes.fileCount == 5 && pip.changes.truncated && pip.changes.added == 9)
        #expect(!r.ducks[1].onDuty && r.ducks[1].changes.files.isEmpty && r.ducks[1].colourSeed == "d2")
    }

    @Test func aFolderPondHasNoMain() throws {
        let r = try JSONDecoder().decode(HostPondChanges.self, from: Data(#"{"projectId":"p","ducks":[],"ducksTruncated":false}"#.utf8))
        #expect(r.main == nil && r.ducks.isEmpty)
    }

    @Test func clientReadsTheRouteAndAnOlderHostIsNil() async throws {
        let t = Replier(Self.json)
        let c = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" })
        let r = try #require(try await c.pondChanges(projectId: "p1"))
        #expect(t.last?.method == "GET" && t.last?.url.path == "/native/projects/p1/changes" && r.ducks.count == 2)
        let old = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: Replier("{}", status: 404), tokenProvider: { "tok" })
        #expect(try await old.pondChanges(projectId: "p1") == nil)
    }
}
