import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondDirectoryTests {
    private let json = #"""
    {"schema":1,
     "ponds":[
       {"id":"p1","kind":"project","name":"squeak","projectId":"p1","pondId":"pd1","shared":false,"members":[{"name":"A","online":true}],
        "labels":["work"],"streams":[{"id":"w1","name":"mallard","branch":"mallard"}],"archivedStreams":2,
        "counts":{"threads":3,"needsYou":1,"working":0},"folder":"/repos/squeak"},
       {"id":"j1","kind":"joined","name":"Shared","pondId":"j1","shared":true,"members":[],"hidden":true,"streams":[],
        "counts":{"threads":0,"needsYou":0,"working":0}}],
     "order":{"mode":"manual","ids":["j1","p1"]},
     "threads":{"squeak-native:a":"p1","squeak-native:b":null},
     "other":["squeak-native:b"]}
    """#

    private func decode() throws -> PondDirectory { try JSONDecoder().decode(PondDirectory.self, from: Data(json.utf8)) }

    @Test func decodesTheHostsShape() throws {
        let d = try decode()
        #expect(d.ponds.map(\.id) == ["p1", "j1"])
        #expect(d.ponds[0].projectId == "p1" && d.ponds[0].pondId == "pd1" && !d.ponds[0].isJoined)
        #expect(d.ponds[0].streams.first?.branch == "mallard" && d.ponds[0].archivedStreams == 2 && d.ponds[0].counts.needsYou == 1)
        #expect(d.ponds[1].isJoined && d.ponds[1].hidden && d.ponds[1].projectId == nil)
        #expect(d.order.mode == .manual && d.order.ids == ["j1", "p1"])
        #expect(d.other == ["squeak-native:b"])
    }

    @Test func aThreadSitsWhereTheDirectorySaysAndOtherIsNil() throws {
        let d = try decode()
        #expect(d.place(sessionKey: "squeak-native:a", cwd: nil) == "p1")
        // The host's null is Other, even when the folder would match a pond.
        #expect(d.place(sessionKey: "squeak-native:b", cwd: "/repos/squeak/x") == nil)
        #expect(d.place(sessionKey: "t-1", cwd: "/repos/squeak/sub") == "p1")
        #expect(d.place(sessionKey: "t-2", cwd: "/repos/squeak-other") == nil)
        #expect(d.place(sessionKey: "t-3", cwd: nil) == nil)
    }

    @Test func theDaemonsPondIdWinsOverTheFolderRule() throws {
        let d = try decode()
        let state = #"{"sessions":[],"active":[{"key":"t-wt","cwd":"/elsewhere/hong-kong","pondId":"p1"}],"others":[{"key":"t-old","cwd":"/repos/squeak/x"}]}"#
        let decoded = try JSONDecoder().decode(DaemonState.self, from: Data(state.utf8))
        let mapped = decoded.sessions.map { DaemonAdapter.map($0) }
        let wt = try #require(mapped.first { $0.key.hostSessionId == "t-wt" })
        let old = try #require(mapped.first { $0.key.hostSessionId == "t-old" })
        #expect(wt.pondId == "p1" && old.pondId == nil)
        // A worktree outside the folder is in its pond because the daemon said so.
        #expect(d.place(sessionKey: wt.key.hostSessionId, cwd: wt.cwd, pondId: wt.pondId) == "p1")
        // No pondId (an older daemon): the old folder rule.
        #expect(d.place(sessionKey: old.key.hostSessionId, cwd: old.cwd, pondId: old.pondId) == "p1")
        #expect(d.place(sessionKey: "t-wt", cwd: "/elsewhere/hong-kong") == nil)
    }

    @Test func aFolderNeverMakesAPondByName() throws {
        // A directory with no row for a folder has no row for it: lookups are by id only.
        let d = try decode()
        #expect(d.pond(id: "ushuaia") == nil && d.pond(projectId: "ushuaia") == nil)
        #expect(d.pond(pondId: "pd1")?.id == "p1")
    }

    @Test func theFilterKeepsTheDirectoryOrderAndOnlyTheToggleHides() throws {
        let d = try decode()
        let entries = d.ponds.map { PondFilter.Entry(id: $0.id, name: $0.name, hidden: $0.hidden, labels: $0.labels, shared: $0.shared) }
        #expect(PondFilter.apply(entries, label: nil, showHidden: false).ids == ["p1"])
        #expect(PondFilter.apply(entries, label: nil, showHidden: true).ids == ["p1", "j1"])
    }

    @Test func clientAsksTheDirectoryAndAnOldHostIsNil() async throws {
        let ok = DirectoryStub(status: 200, body: json)
        let c = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: ok, tokenProvider: { "tok" })
        #expect(try await c.directory()?.ponds.count == 2)
        #expect(ok.last == "GET /native/directory")
        let old = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: DirectoryStub(status: 404, body: "{}"), tokenProvider: { "tok" })
        #expect(try await old.directory() == nil)
    }
}

private final class DirectoryStub: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: String?
    let status: Int, body: String
    init(status: Int, body: String) { self.status = status; self.body = body }
    var last: String? { lock.withLock { seen } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { seen = "\(request.method) \(request.url.path)" }
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}
