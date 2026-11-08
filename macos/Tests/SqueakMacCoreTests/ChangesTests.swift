import Foundation
import Testing
@testable import SqueakMacCore

private final class ChangesStub: HTTPTransport, @unchecked Sendable {
    let status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int, body: String) { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

@Suite("Changes")
struct ChangesTests {
    private func client(_ t: ChangesStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }

    @Test func decodesChangesAndSendsTheToken() async throws {
        let t = ChangesStub(status: 200, body: #"{"base":"origin/master","files":[{"path":"src/a.ts","status":"M","added":3,"removed":1},{"path":"new.txt","status":"A","added":2,"removed":0},{"nope":1}],"totals":{"added":5,"removed":1,"files":2}}"#)
        let c = try #require(try await client(t).changes(sessionKey: "claude-transcript:t1"))
        #expect(c.files.map(\.path) == ["src/a.ts", "new.txt"])
        #expect(c.added == 5 && c.removed == 1)
        #expect(t.requests[0].headers["x-squeak-token"] == "tok")
        #expect(t.requests[0].url.absoluteString.hasSuffix("/claude-transcript:t1/changes"))
        #expect(ChangesPresentation.summary(c) == "2 files · +5 −1 · vs master")
    }

    @Test func olderDaemonIsNilAndPathIsEncoded() async throws {
        #expect(try await client(ChangesStub(status: 404, body: "")).changes(sessionKey: "k") == nil)
        let t = ChangesStub(status: 200, body: #"{"path":"a b/c&d.ts","patch":"@@ -1 +1 @@\n-a\n+b","truncated":true}"#)
        let p = try #require(try await client(t).changePatch(sessionKey: "k", path: "a b/c&d.ts"))
        #expect(p.truncated && p.patch.hasPrefix("@@"))
        #expect(t.requests[0].url.absoluteString.hasSuffix("/changes/file?path=a%20b%2Fc%26d.ts") || t.requests[0].url.absoluteString.contains("path=a%20b/c%26d.ts"))
        #expect(try await client(ChangesStub(status: 404, body: "")).changePatch(sessionKey: "k", path: "x") == nil)
    }

    @Test func groupsByFolderRootFirst() {
        let files = ["src/b.ts", "README.md", "src/a.ts", "docs/x.md"].map { DaemonChanges.File(path: $0) }
        let g = ChangesPresentation.byFolder(files)
        #expect(g.map(\.folder) == ["", "docs", "src"])
        #expect(g[2].files.map(\.path) == ["src/a.ts", "src/b.ts"])
    }

    @Test func refreshPolicyNeverRunsHidden() {
        let now = Date()
        #expect(!ChangesPresentation.shouldRefresh(visible: false, activityChanged: true, lastRead: nil, now: now))
        #expect(ChangesPresentation.shouldRefresh(visible: true, activityChanged: true, lastRead: now, now: now))
        #expect(!ChangesPresentation.shouldRefresh(visible: true, activityChanged: false, lastRead: now.addingTimeInterval(-3), now: now))
        #expect(ChangesPresentation.shouldRefresh(visible: true, activityChanged: false, lastRead: now.addingTimeInterval(-10), now: now))
    }

    @Test func parsesDiffLinesWithNumbers() {
        let l = DiffParser.lines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,3 +3,4 @@ fn\n keep\n-old\n+new\n+more\n\\ No newline at end of file")
        #expect(l.map(\.kind) == [.hunk, .context, .removed, .added, .added, .note])
        #expect(l[1].oldNumber == 3 && l[1].newNumber == 3)
        #expect(l[2].oldNumber == 4 && l[2].newNumber == nil)
        #expect(l[3].newNumber == 4 && l[4].newNumber == 5)
    }
}
