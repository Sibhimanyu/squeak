import Foundation
import Testing
@testable import SqueakMacCore

private final class Replier: HTTPTransport, @unchecked Sendable {
    var last: HTTPRequest?
    let reply: String
    init(_ reply: String) { self.reply = reply }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        last = request
        return HTTPResponse(status: 200, body: Data(reply.utf8))
    }
}

@Suite struct ArtifactsTests {
    private func item(_ path: String, duck: String? = nil, id: String? = nil, at: Double, branch: String? = nil) -> ArtifactItem {
        ArtifactItem(path: path, duckId: id ?? duck, duckName: duck, branch: branch, modifiedAt: Date(timeIntervalSince1970: at))
    }

    @Test func kindFromExtensionMatchesTheHost() {
        let cases: [(String, ArtifactKind)] = [
            ("a.HTML", .page), ("a.md", .page), ("a.psd", .psd), ("a.ai", .ai), ("a.svg", .svg), ("a.pdf", .pdf),
            ("a.webp", .image), ("a.txt", .doc), ("a.swift", .other), ("noext", .other),
        ]
        for (path, kind) in cases { #expect(ArtifactKind(path: path) == kind, "\(path)") }
        #expect(ArtifactKind(wire: "psd") == .psd && ArtifactKind(wire: "future") == .other && ArtifactKind(wire: nil) == .other)
    }

    @Test func groupsByDuckNewestFirst() {
        let groups = Artifacts.grouped([
            item("/a/old.png", duck: "Pip", at: 10), item("/a/main.pdf", at: 50), item("/a/new.png", duck: "Pip", at: 30),
            item("/a/other.svg", duck: "Moss", at: 40),
        ])
        #expect(groups.map(\.title) == ["Main", "Moss", "Pip"])
        #expect(groups[2].items.map(\.name) == ["new.png", "old.png"])
        #expect(Artifacts.grouped([]).isEmpty)
    }

    @Test func aDuckWithAnIdStaysOneGroupWhateverItsName() {
        let g = Artifacts.grouped([item("/a/1.png", duck: "Pip", id: "d1", at: 2), item("/a/2.png", duck: nil, id: "d1", at: 1)])
        #expect(g.count == 1 && g[0].title == "Pip" && g[0].items.count == 2)
    }

    @Test func metaIsDuckBranchAge() {
        let now = Date(timeIntervalSince1970: 100_000)
        let i = item("/a/x.png", duck: "Pip", at: 100_000 - 3 * 3600, branch: "feature/x")
        #expect(Artifacts.meta(i, now: now) == "Pip \u{00B7} feature/x \u{00B7} 3h")
        #expect(Artifacts.meta(item("/a/y.png", at: 100_000), now: now) == "now")
    }

    @Test func previewChoicePerKind() {
        #expect(ArtifactPreview.choose(kind: .page, path: "/a/p.html") == .web)
        #expect(ArtifactPreview.choose(kind: .page, path: "/a/p.md") == .markdown)
        #expect(ArtifactPreview.choose(kind: .svg, path: "/a/p.svg") == .image)
        #expect(ArtifactPreview.choose(kind: .pdf, path: "/a/p.pdf") == .pdf)
        #expect(ArtifactPreview.choose(kind: .ai, path: "/a/p.ai") == .pdf)
        #expect(ArtifactPreview.choose(kind: .psd, path: "/a/p.psd") == .quickLook)
        #expect(ArtifactPreview.fallback(after: .pdf, kind: .ai) == nil)
        #expect(ArtifactPreview.fallback(after: .pdf, kind: .pdf) == .quickLook)
        #expect(Artifacts.openLabel(.psd) == "Open in Photoshop" && Artifacts.openLabel(.ai) == "Open in Illustrator")
        #expect(Artifacts.openLabel(.pdf) == "Open")
    }

    @Test func hostRouteDecodesAndSkipsBadRows() async throws {
        let t = Replier(#"{"artifacts":[{"path":"/r/a.html","name":"a.html","kind":"page","duckId":"d","duckName":"Pip","branch":"b","source":"shown","modifiedAt":1700000000000,"size":12},{"nope":1},{"path":"/r/b.psd","kind":"zzz","source":"found"}]}"#)
        let c = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" })
        let rows = try await c.artifacts(projectId: "p 1")
        #expect(t.last?.url.path == "/native/projects/p%201/artifacts" || t.last?.url.path == "/native/projects/p 1/artifacts")
        #expect(rows.count == 2 && rows[0].shown && rows[0].duckName == "Pip" && rows[0].kind == .page && rows[0].size == 12)
        #expect(rows[0].modifiedAt == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(rows[1].kind == .other && !rows[1].shown && rows[1].name == "b.psd")
    }
}
