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

    @Test func previewChoicePerFormat() {
        let cases: [(String, ArtifactPreview)] = [
            ("/a/p.html", .web), ("/a/p.HTM", .web), ("/a/p.md", .markdown), ("/a/p.pdf", .pdf), ("/a/p.ai", .illustrator),
            ("/a/p.psd", .image), ("/a/p.tiff", .image), ("/a/p.heic", .image), ("/a/p.png", .image), ("/a/p.jpg", .image),
            ("/a/p.gif", .image), ("/a/p.webp", .image), ("/a/p.svg", .svg),
            ("/a/p.pptx", .quickLook), ("/a/p.ppt", .quickLook), ("/a/p.key", .quickLook), ("/a/p.docx", .quickLook),
            ("/a/p.doc", .quickLook), ("/a/p.xlsx", .quickLook), ("/a/p.pages", .quickLook), ("/a/p.numbers", .quickLook),
            ("/a/p.rtf", .quickLook), ("/a/p.mp4", .media), ("/a/p.mov", .media), ("/a/p.m4a", .media), ("/a/p.mp3", .media),
            ("/a/p.swift", .other), ("/a/noext", .other),
        ]
        for (path, preview) in cases { #expect(ArtifactPreview.kind(for: path) == preview, "\(path)") }
        #expect(ArtifactPreview.fallback(after: .pdf) == .quickLook && ArtifactPreview.fallback(after: .illustrator) == nil)
        #expect(ArtifactPreview.fallback(after: .quickLook) == nil && ArtifactPreview.fallback(after: .other) == nil)
    }

    @Test func newKindsAndOpenLabels() {
        let cases: [(String, ArtifactKind)] = [
            ("a.pptx", .slides), ("a.key", .slides), ("a.ppt", .slides), ("a.docx", .doc), ("a.pages", .doc), ("a.xlsx", .doc),
            ("a.numbers", .doc), ("a.csv", .doc), ("a.mp4", .video), ("a.mov", .video), ("a.m4a", .audio), ("a.mp3", .audio),
        ]
        for (path, kind) in cases { #expect(ArtifactKind(path: path) == kind, "\(path)") }
        #expect(ArtifactKind(wire: "slides") == .slides && ArtifactKind(wire: "video") == .video && ArtifactKind(wire: "hologram") == .other)
        #expect(Artifacts.openLabel(kind: .slides, systemApp: "Keynote") == "Open in Keynote")
        #expect(Artifacts.openLabel(kind: .ai, systemApp: nil) == "Open with\u{2026}")
        #expect(Artifacts.openLabel(kind: .pdf, systemApp: " ") == "Open with\u{2026}")
        let i = ArtifactItem(path: "/a/d.pptx", duckName: "Pip", branch: "feature/x", size: 2_000_000)
        #expect(Artifacts.viewerMeta(i, extras: ["12 slides"]) == "Pip \u{00B7} feature/x \u{00B7} Slides \u{00B7} 12 slides \u{00B7} " + Artifacts.sizeText(2_000_000))
        #expect(Artifacts.viewerMeta(ArtifactItem(path: "/a/x.png", size: 0)) == "Image")
        #expect(Artifacts.openLabel(.psd) == "Open in Photoshop" && Artifacts.openLabel(.pdf) == "Open")
    }

    @Test func slideCountFromZipEntries() {
        #expect(SlideCount.pptx(entries: ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/_rels/slide1.xml.rels", "ppt/slideLayouts/slideLayout1.xml"]) == 2)
        #expect(SlideCount.pptx(entries: ["ppt/presentation.xml"]) == nil)
    }

    @Test func zoomStaysInRange() {
        #expect(ArtifactPreview.zoomed(1, in: true) == 1.25)
        #expect(ArtifactPreview.zoomed(8, in: true) == 8 && ArtifactPreview.zoomed(0.1, in: false) == 0.1)
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

    @Test func searchFiltersByNamePathDuckBranchAndKind() {
        let a = ArtifactItem(path: "/r/poster/Hero.psd", duckName: "Pip", branch: "feature/Hero")
        let b = ArtifactItem(path: "/r/docs/plan.html", duckName: "Quill", branch: "main")
        let c = ArtifactItem(path: "/r/out/deck.pptx")
        let all = [a, b, c]
        #expect(Artifacts.filter(all, query: "") == all)
        #expect(Artifacts.filter(all, query: "   ") == all)
        #expect(Artifacts.filter(all, query: "HERO") == [a])
        #expect(Artifacts.filter(all, query: "docs/") == [b])
        #expect(Artifacts.filter(all, query: "quill") == [b])
        #expect(Artifacts.filter(all, query: "feature") == [a])
        #expect(Artifacts.filter(all, query: "slides") == [c])
        #expect(Artifacts.filter(all, query: "photoshop") == [a])
        #expect(Artifacts.filter(all, query: "pip psd") == [a])
        #expect(Artifacts.filter(all, query: "pip html").isEmpty)
        #expect(Artifacts.noMatch(" zzz ") == "No artifacts match \u{201C}zzz\u{201D}.")
    }
}
