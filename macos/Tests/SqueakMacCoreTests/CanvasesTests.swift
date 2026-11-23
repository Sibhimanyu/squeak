import XCTest
@testable import SqueakMacCore

final class CanvasesTests: XCTestCase {
    private func board(_ id: String, _ w: Double = 1920, _ h: Double = 1080, at: Int64 = 1, bg: String? = nil) -> CanvasArtboardInfo {
        CanvasArtboardInfo(id: id, name: id.capitalized, width: w, height: h, background: bg, file: "/c/\(id).html", modifiedAt: at)
    }

    func testKindsDecodeAndNameThemselves() {
        XCTAssertEqual(CanvasKind.allCases.map(\.menuTitle), ["Deck", "Poster", "Logo sheet", "Social post", "Blank"])
        XCTAssertEqual(CanvasKind(wire: "logo"), .logo)
        XCTAssertEqual(CanvasKind(wire: "mystery"), .blank)
        XCTAssertEqual(CanvasKind(wire: nil), .blank)
        XCTAssertEqual(ArtifactKind(path: "/p/canvases/x.canvas"), .canvas)
        XCTAssertEqual(ArtifactKind(wire: "canvas"), .canvas)
        XCTAssertEqual(ArtifactPreview.kind(for: "/p/x.canvas"), .canvas)
    }

    func testSummaryDecodesHostRow() throws {
        let json = #"{"canvases":[{"path":"/p/canvases/a.canvas","slug":"a","title":"Pitch","kind":"deck","artboards":6,"modifiedAt":1700000000000,"duckName":"Pip","branch":"b"},{"nope":1}]}"#
        struct L: Decodable { var canvases: [Failable<CanvasSummary>] }
        let rows = try JSONDecoder().decode(L.self, from: Data(json.utf8)).canvases.compactMap(\.value)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].title, "Pitch")
        XCTAssertEqual(rows[0].kind, .deck)
        XCTAssertEqual(rows[0].artboards, 6)
        XCTAssertEqual(rows[0].duckName, "Pip")
        XCTAssertEqual(rows[0].modifiedAt, Date(timeIntervalSince1970: 1_700_000_000))
    }

    func testDetailDecodesHostCanvas() throws {
        let json = #"{"path":"/p/a.canvas","canvas":{"version":1,"title":"Pitch","kind":"poster","artboards":[]},"artboards":[{"id":"title","name":"Title","width":1080,"height":1350,"file":"/p/a.canvas/artboards/title.html","modifiedAt":42}],"assetsModifiedAt":7}"#
        let d = try JSONDecoder().decode(CanvasDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.title, "Pitch")
        XCTAssertEqual(d.kind, .poster)
        XCTAssertEqual(d.artboards.first?.size, CGSize(width: 1080, height: 1350))
        XCTAssertEqual(d.artboards.first?.modifiedAt, 42)
        XCTAssertEqual(d.assetsModifiedAt, 7)
    }

    func testOnlyChangedBoardsNeedRedrawing() {
        var detail = CanvasDetail(path: "/c", title: "T", artboards: [board("a"), board("b"), board("c")], assetsModifiedAt: 5)
        var drawn: [String: CanvasBoards.Stamp] = [:]
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), ["a", "b", "c"])
        for b in detail.artboards { drawn[b.id] = CanvasBoards.Stamp(b, assetsModifiedAt: 5) }
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), [])
        // A duck rewrites slide b.
        detail.artboards[1] = board("b", at: 2)
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), ["b"])
        // A resize and a background change count too.
        detail.artboards[1] = board("b", at: 1)
        detail.artboards[2] = board("c", 800, 600)
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), ["c"])
        detail.artboards[2] = board("c", bg: "#000")
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), ["c"])
        // A picture in assets/ changed: everything is stale.
        detail.artboards[2] = board("c")
        detail.assetsModifiedAt = 6
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), ["a", "b", "c"])
        // A new artboard is drawn alone; a deleted one is forgotten.
        detail.assetsModifiedAt = 5
        detail.artboards = [board("a"), board("d")]
        XCTAssertEqual(CanvasBoards.needingRender(drawn: drawn, detail: detail), ["d"])
        XCTAssertEqual(Set(CanvasBoards.pruned(drawn: drawn, detail: detail).keys), ["a"])
    }

    func testPondPageWords() {
        XCTAssertEqual(CanvasBoards.countText(1), "1 artboard")
        XCTAssertEqual(CanvasBoards.countText(6), "6 artboards")
        let now = Date()
        let c = CanvasSummary(path: "/p", title: "Pitch", kind: .deck, artboards: 6, modifiedAt: now.addingTimeInterval(-7200))
        XCTAssertEqual(CanvasBoards.meta(c, now: now), "Deck \u{00B7} 6 artboards \u{00B7} " + PickerRows.age(c.modifiedAt, now: now))
        XCTAssertEqual(CanvasBoards.askPrefill(title: "Pitch"), "In canvas Pitch, ")
        XCTAssertNil(CanvasBoards.frame(at: 3, in: [.zero]))
        XCTAssertNotNil(CanvasBoards.frame(at: 0, in: [.zero]))
    }

    func testExportNamesAreSafeOrderedAndDistinct() {
        XCTAssertEqual(CanvasExport.pdfName(canvas: "Q3 Launch / Deck"), "Q3-Launch-Deck.pdf")
        XCTAssertEqual(CanvasExport.pdfName(canvas: "///"), "canvas.pdf")
        XCTAssertEqual(CanvasExport.pngName(canvas: "Pitch", board: "Agenda", index: 1, count: 6, scale: .two), "Pitch-02-Agenda@2x.png")
        XCTAssertEqual(CanvasExport.pngName(canvas: "Pitch", board: "Agenda", index: 1, count: 6, scale: .one), "Pitch-02-Agenda.png")
        XCTAssertEqual(CanvasExport.pngName(canvas: "P", board: "", index: 99, count: 120, scale: .one), "P-100-artboard.png")
        let names = (0..<3).map { CanvasExport.pngName(canvas: "P", board: "Same", index: $0, count: 3, scale: .one) }
        XCTAssertEqual(Set(names).count, 3)
        XCTAssertEqual(CanvasExport.folderName(canvas: "My Deck"), "My-Deck-png")
        XCTAssertFalse(CanvasExport.pngName(canvas: "../x", board: "a/b", index: 0, count: 1, scale: .one).contains("/"))
    }

    func testExportTargetsSizesAndProgress() {
        XCTAssertEqual(CanvasExport.targets(all: true, selected: 0, count: 3), [0, 1, 2])
        XCTAssertEqual(CanvasExport.targets(all: false, selected: 2, count: 3), [2])
        XCTAssertEqual(CanvasExport.targets(all: false, selected: 9, count: 3), [2])
        XCTAssertEqual(CanvasExport.targets(all: true, selected: 0, count: 0), [])
        XCTAssertEqual(CanvasExport.pixelSize(CGSize(width: 1920, height: 1080), scale: .two), CGSize(width: 3840, height: 2160))
        XCTAssertEqual(CanvasExport.pixelSize(CGSize(width: 1080, height: 1350), scale: .one), CGSize(width: 1080, height: 1350))
        XCTAssertEqual(CanvasExport.progressText(done: 0, total: 6), "Exporting 1 of 6\u{2026}")
        XCTAssertEqual(CanvasExport.progressText(done: 6, total: 6), "Exporting 6 of 6\u{2026}")
    }

    func testBoardsLayOutSideBySideWithGaps() {
        let frames = ArtboardLayout.place([CGSize(width: 1920, height: 1080), CGSize(width: 1080, height: 1350)])
        XCTAssertEqual(frames[1].minX, 1920 + ArtboardLayout.gap)
        XCTAssertEqual(ArtboardLayout.bounds(frames).height, 1350)
    }
}
