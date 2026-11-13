import Foundation
import Testing
@testable import SqueakMacCore

private final class Recorder: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [HTTPRequest] = []
    let reply: String
    init(_ reply: String) { self.reply = reply }
    var last: HTTPRequest? { lock.withLock { log.last } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { log.append(request) }
        return HTTPResponse(status: 200, body: Data(reply.utf8))
    }
}

private func client(_ r: Recorder) -> NativeHostClient {
    NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: r, tokenProvider: { "tok" })
}

private func body(_ r: Recorder) -> NativeJSON? {
    r.last?.body.flatMap { try? JSONDecoder().decode(NativeJSON.self, from: $0) }
}

@Suite struct NativeCreationRoutesTests {
    let project = #"{"project":{"id":"p","name":"n","rootPath":"/r","defaultBranch":"main"}}"#
    let workspace = #"{"workspace":{"id":"w","projectId":"p","name":"w","path":"/w","branch":"b"}}"#

    @Test func branchesDecodeAndFetchIsAQuery() async throws {
        let r = Recorder(#"{"branches":[{"name":"main","remote":true,"current":true,"checkedOut":true,"lastCommitAt":"2026-11-10T10:00:00.000Z"},{"name":"x"}]}"#)
        let list = try await client(r).branches(projectId: "p", fetch: true)
        #expect(r.last?.url.path == "/native/projects/p/branches" && r.last?.url.query == "fetch=1")
        #expect(list.count == 2 && list[0].checkedOut && list[0].lastCommitAt != nil && !list[1].checkedOut)
        _ = try await client(r).branches(projectId: "p")
        #expect(r.last?.url.query == nil)
    }

    @Test func pullsAndIssuesDecodeIncludingUnavailable() async throws {
        let r = Recorder(#"{"items":[{"number":3,"title":"T","author":"a","updatedAt":"2026-11-10T10:00:00Z","branch":"b","fork":true,"url":"u"}],"available":true}"#)
        let got = try await client(r).pulls(projectId: "p")
        #expect(r.last?.url.path == "/native/projects/p/pulls")
        #expect(got.available && got.items.first?.number == 3 && got.items.first?.fork == true && got.items.first?.branch == "b")
        let none = Recorder(#"{"items":[],"available":false,"reason":"gh is not signed in"}"#)
        let l = try await client(none).issues(projectId: "p")
        #expect(none.last?.url.path == "/native/projects/p/issues" && !l.available && l.reason == "gh is not signed in" && l.items.isEmpty)
    }

    @Test func projectNamesAreSentOnlyWhenTyped() async throws {
        let r = Recorder(project)
        _ = try await client(r).addProject(rootPath: "/r", name: " Orchard ")
        #expect(body(r)?["name"]?.string == "Orchard" && body(r)?["rootPath"]?.string == "/r")
        _ = try await client(r).addProject(rootPath: "/r", name: "  ")
        #expect(body(r)?["name"] == nil)
        _ = try await client(r).cloneProject(url: "o/r", name: "Mine")
        #expect(r.last?.url.path == "/native/projects/clone" && body(r)?["name"]?.string == "Mine")
    }

    @Test func workspaceBranchIsSentOnlyWhenTyped() async throws {
        let r = Recorder(workspace)
        _ = try await client(r).createWorkspace(projectId: "p", branch: "feat/x")
        #expect(body(r)?["branch"]?.string == "feat/x")
        _ = try await client(r).createWorkspace(projectId: "p")
        #expect(body(r)?["branch"] == nil)
        let c = Recorder(#"{"workspace":{"id":"w","projectId":"p","name":"w","path":"/w","branch":"b"}}"#)
        _ = try await client(c).createWorkspace(projectId: "p", from: .issue(4), branch: "fix-4")
        #expect(body(c)?["branch"]?.string == "fix-4" && body(c)?["from"]?["kind"]?.string == "issue")
    }

    @Test func streamNameIsSuggestedAndSentAndTheTitleDecodes() async throws {
        let sug = Recorder(#"{"title":"Detached HEAD Duck","slug":"detached-head-duck","branch":"me/detached-head-duck"}"#)
        let s = try await client(sug).suggestStream(projectId: "p")
        #expect(sug.last?.url.path == "/native/projects/p/suggest-stream" && s.title == "Detached HEAD Duck" && s.slug == "detached-head-duck")
        let r = Recorder(#"{"workspace":{"id":"w","projectId":"p","name":"wood-duck","path":"/w","branch":"b"}}"#)
        let ws = try await client(r).createWorkspace(projectId: "p", name: " Quiet Creek ")
        #expect(body(r)?["name"]?.string == "Quiet Creek" && body(r)?["branch"] == nil)
        #expect(ws.title == nil && ws.displayTitle == "Wood Duck")
        let t = Recorder(#"{"workspace":{"id":"w","projectId":"p","name":"detached-head-duck","path":"/w","branch":"b","title":"Detached HEAD Duck"}}"#)
        #expect(try await client(t).createWorkspace(projectId: "p").displayTitle == "Detached HEAD Duck")
    }

    @Test func aChatStartedInAStreamSendsItsWorkspaceId() async throws {
        let r = Recorder(#"{"session":{"id":"s","cwd":"/w","agent":"claude","model":"m","permissionMode":"default","status":"idle"}}"#)
        _ = try await client(r).createSession(NativeNewSession(agent: "claude", model: "m", projectId: "p", text: "go", workspaceId: "ws1"))
        #expect(body(r)?["workspaceId"]?.string == "ws1" && body(r)?["cwd"] == nil && body(r)?["main"] == nil)
        // Main never carries a stream.
        _ = try await client(r).createSession(NativeNewSession(agent: "claude", model: "m", projectId: "p", main: true, workspaceId: "ws1"))
        #expect(body(r)?["workspaceId"] == nil && body(r)?["main"]?.bool == true)
    }

    @Test func newSessionCarriesBranchAndSplit() async throws {
        let r = Recorder(#"{"session":{"id":"s","cwd":"/w","agent":"claude","model":"m","permissionMode":"default","status":"idle"}}"#)
        let spec = NativeNewSession(agent: "claude", model: "m", projectId: "p", newWorkspace: true, branch: "feat", text: "go",
                                    split: WorkSplit(code: "sonnet", run: "haiku"))
        _ = try await client(r).createSession(spec)
        let b = body(r)
        #expect(b?["newWorkspace"]?["branch"]?.string == "feat" && b?["projectId"]?.string == "p")
        #expect(b?["split"]?["code"]?.string == "sonnet" && b?["split"]?["run"]?.string == "haiku")
        _ = try await client(r).createSession(NativeNewSession(agent: "claude", model: "m", projectId: "p", newWorkspace: true, text: "go", split: WorkSplit()))
        #expect(body(r)?["newWorkspace"]?.bool == true && body(r)?["split"] == nil)
    }
}
