import CoreGraphics
import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ArtifactCanvasTests {
    @Test func illustratorStubTextIsRecognised() {
        let stub = "This is an Adobe\u{00AE} Illustrator\u{00AE} File that was saved\nwithout  PDF Content. To Place or open this file in other applications, it should be re-saved"
        #expect(IllustratorStub.isStub(pageText: stub))
        #expect(!IllustratorStub.isStub(pageText: "Quarterly report"))
        #expect(!IllustratorStub.isStub(pageText: nil) && !IllustratorStub.isStub(pageText: ""))
    }

    @Test func renderCacheKeyFollowsPathAndMtime() {
        let t = Date(timeIntervalSince1970: 1_700_000_000)
        let k = ArtifactRenderCache.key(path: "/a/b.ai", modified: t)
        #expect(k.count == 16)
        #expect(k == ArtifactRenderCache.key(path: "/a/b.ai", modified: t))
        #expect(k != ArtifactRenderCache.key(path: "/a/c.ai", modified: t))
        #expect(k != ArtifactRenderCache.key(path: "/a/b.ai", modified: t.addingTimeInterval(1)))
        let f = ArtifactRenderCache.folder(support: URL(fileURLWithPath: "/s"), path: "/a/b.ai", modified: t)
        #expect(f.path == "/s/artifact-render/\(k)")
    }

    @Test func scriptEscapesPathsAndNamesParse() {
        let s = ArtifactRenderCache.script(file: "/x/it's \"a\".ai", out: "/o")
        #expect(s.contains("new File(\"/x/it's \\\"a\\\".ai\")"))
        #expect(s.contains("new Folder(\"/o\")"))
        #expect(s.contains("DONOTSAVECHANGES"))
        #expect(s.contains("try {"))
        #expect(s.contains("} catch (e) {"))
        #expect(s.contains("names.json"))
        #expect(ArtifactRenderCache.names(from: Data("[\"A\",\"B\"]".utf8)) == ["A", "B"])
        #expect(ArtifactRenderCache.names(from: Data("nope".utf8)) == nil)
    }

    @Test func parseScriptResultDistinguishesOkAndError() {
        #expect(ArtifactRenderCache.parseResult("ok:3") == .ok(artboards: 3))
        #expect(ArtifactRenderCache.parseResult("ok:0") == .ok(artboards: 0))
        #expect(ArtifactRenderCache.parseResult("ok:42\n") == .ok(artboards: 42))
        #expect(ArtifactRenderCache.parseResult("ok") == .ok(artboards: 1))
        #expect(ArtifactRenderCache.parseResult("error: File not found line 7") == .error("File not found line 7"))
        #expect(ArtifactRenderCache.parseResult("error: ") == .error("Unknown Illustrator error."))
        #expect(ArtifactRenderCache.parseResult("Adobe Illustrator got an error: missing (1252)") == .error("Adobe Illustrator got an error: missing (1252)"))
        #expect(ArtifactRenderCache.parseResult("") == nil)
        #expect(ArtifactRenderCache.parseResult("  \n\t ") == nil)
    }

    @Test func zoomClampsAndStepsThroughStops() {
        #expect(CanvasZoom.clamp(0.001) == 0.02 && CanvasZoom.clamp(500) == 64 && CanvasZoom.clamp(1) == 1)
        #expect(CanvasZoom.step(1, in: true) == 1.5 && CanvasZoom.step(1, in: false) == 0.6667)
        #expect(CanvasZoom.step(0.83, in: true) == 1 && CanvasZoom.step(0.83, in: false) == 0.6667)
        #expect(CanvasZoom.step(64, in: true) == 64 && CanvasZoom.step(0.02, in: false) == 0.02)
        #expect(CanvasZoom.percentText(0.83) == "83%" && CanvasZoom.percentText(0.02) == "2%" && CanvasZoom.percentText(64) == "6400%")
        #expect(CanvasZoom.factor(magnification: -2) > 0)
    }

    @Test func zoomKeepsTheWorldPointUnderTheCursor() {
        let v = CanvasViewport(origin: CGPoint(x: 100, y: 50), zoom: 1)
        let anchor = CGPoint(x: 300, y: 200)
        let before = v.world(fromView: anchor)
        let z = v.zoomed(to: 4, anchor: anchor)
        #expect(z.zoom == 4)
        let after = z.world(fromView: anchor)
        #expect(abs(after.x - before.x) < 1e-9 && abs(after.y - before.y) < 1e-9)
        #expect(v.zoomed(to: 1000, anchor: anchor).zoom == 64)
    }

    @Test func panFollowsTheFingersAtAnyZoom() {
        let v = CanvasViewport(origin: .zero, zoom: 2).panned(byView: CGSize(width: 20, height: -10))
        #expect(v.origin == CGPoint(x: -10, y: 5))
    }

    @Test func fittingCentresAndNeverBlowsUpASmallBoard() {
        let v = CanvasViewport.fitting(CGRect(x: 0, y: 0, width: 1000, height: 500), in: CGSize(width: 548, height: 400), padding: 24)
        #expect(abs(v.zoom - 0.5) < 1e-9)
        let c = v.view(fromWorld: CGPoint(x: 500, y: 250))
        #expect(abs(c.x - 274) < 1e-9 && abs(c.y - 200) < 1e-9)
        #expect(CanvasViewport.fitting(CGRect(x: 0, y: 0, width: 10, height: 10), in: CGSize(width: 800, height: 600)).zoom == 1)
    }

    @Test func previewMapsACommittedLayerToTheLiveViewport() {
        let committed = CanvasViewport(origin: CGPoint(x: 10, y: 20), zoom: 2)
        let live = committed.zoomed(to: 4, anchor: CGPoint(x: 50, y: 50))
        let p = live.preview(from: committed)
        let w = CGPoint(x: 33, y: 41)
        let c = committed.view(fromWorld: w)
        let mapped = CGPoint(x: c.x * p.scale + p.translate.width, y: c.y * p.scale + p.translate.height)
        let want = live.view(fromWorld: w)
        #expect(abs(mapped.x - want.x) < 1e-9 && abs(mapped.y - want.y) < 1e-9)
    }

    @Test func artboardsSitSideBySide() {
        let f = ArtboardLayout.place([CGSize(width: 100, height: 200), CGSize(width: 50, height: 80)], gap: 10)
        #expect(f == [CGRect(x: 0, y: 0, width: 100, height: 200), CGRect(x: 110, y: 0, width: 50, height: 80)])
        #expect(ArtboardLayout.bounds(f) == CGRect(x: 0, y: 0, width: 160, height: 200))
        #expect(ArtboardLayout.bounds([]) == .zero)
        #expect(ArtboardLayout.nearest(f, to: CGPoint(x: 120, y: 10)) == 1)
        #expect(ArtboardLayout.nearest(f, to: CGPoint(x: 108, y: 40)) == 1)
        #expect(ArtboardLayout.label(name: " ", index: 2) == "Artboard 3" && ArtboardLayout.label(name: "Cover", index: 0) == "Cover")
    }

    @Test func switcherShowsOnlyForMoreThanOne() {
        #expect(!ArtifactSwitcher.shown(count: 1) && ArtifactSwitcher.shown(count: 2))
        #expect(ArtifactSwitcher.text(index: 0, count: 3) == "1/3")
        #expect(ArtifactSwitcher.stepped(0, by: -1, count: 3) == 0 && ArtifactSwitcher.stepped(2, by: 1, count: 3) == 2 && ArtifactSwitcher.stepped(1, by: 1, count: 3) == 2)
    }
}
