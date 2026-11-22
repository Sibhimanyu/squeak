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

    // MARK: Document size (replaces CanvasViewport tests)

    @Test func documentSizeAddsPadding() {
        let ab = CGRect(x: 0, y: 0, width: 1000, height: 500)
        let vp = CGSize(width: 800, height: 600)
        let ds = CanvasDocumentSize.documentSize(artboardBounds: ab, viewportSize: vp)
        #expect(abs(ds.width - 2600) < 1e-9)
        #expect(abs(ds.height - 1700) < 1e-9)
    }

    @Test func documentOriginOffsetsFromArtboardBounds() {
        let ab = CGRect(x: 100, y: 50, width: 400, height: 300)
        let vp = CGSize(width: 200, height: 150)
        let o = CanvasDocumentSize.documentOrigin(artboardBounds: ab, viewportSize: vp)
        #expect(abs(o.x - (-100)) < 1e-9)
        #expect(abs(o.y - (-100)) < 1e-9)
    }

    @Test func documentSizeMinimumIsOneByOne() {
        let ds = CanvasDocumentSize.documentSize(artboardBounds: .zero, viewportSize: .zero)
        #expect(ds.width >= 1 && ds.height >= 1)
    }

    @Test func fitMagnificationCentresAndNeverBlowsUpASmallBoard() {
        let mag = CanvasDocumentSize.fitMagnification(
            rect: CGRect(x: 0, y: 0, width: 1000, height: 500),
            viewportSize: CGSize(width: 548, height: 400), padding: 24)
        #expect(abs(mag - 0.5) < 1e-9)
        // A small board should not be enlarged past 1×.
        let small = CanvasDocumentSize.fitMagnification(
            rect: CGRect(x: 0, y: 0, width: 10, height: 10),
            viewportSize: CGSize(width: 800, height: 600))
        #expect(small == 1)
    }

    @Test func fitMagnificationHandlesZeroRect() {
        let mag = CanvasDocumentSize.fitMagnification(
            rect: .zero, viewportSize: CGSize(width: 800, height: 600))
        #expect(mag == 1)
    }

    @Test func centredScrollPointCentresTheRect() {
        let ab = CGRect(x: 0, y: 0, width: 1000, height: 500)
        let vp = CGSize(width: 800, height: 600)
        let docOrigin = CanvasDocumentSize.documentOrigin(artboardBounds: ab, viewportSize: vp)
        let pt = CanvasDocumentSize.centredScrollPoint(
            worldRect: ab, magnification: 0.5, viewportSize: vp, docOrigin: docOrigin)
        // Centre of ab in doc coords = (500 - docOrigin.x, 250 - docOrigin.y) = (500+800, 250+600) = (1300, 850)
        // at mag 0.5: (1300*0.5 - 400, 850*0.5 - 300) = (250, 125)
        #expect(abs(pt.x - 250) < 1e-9)
        #expect(abs(pt.y - 125) < 1e-9)
    }

    @Test func centredScrollPointNeverNegative() {
        let ab = CGRect(x: 0, y: 0, width: 100, height: 100)
        let vp = CGSize(width: 2000, height: 2000)
        let docOrigin = CanvasDocumentSize.documentOrigin(artboardBounds: ab, viewportSize: vp)
        let pt = CanvasDocumentSize.centredScrollPoint(
            worldRect: ab, magnification: 1, viewportSize: vp, docOrigin: docOrigin)
        #expect(pt.x >= 0 && pt.y >= 0)
    }

    // MARK: Layout

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

@Suite struct IllustratorAutoTests {
    @Test func rendersByItselfOnlyWhenIllustratorIsOpenAndNothingIsRunning() {
        #expect(IllustratorAuto.shouldRender(appRunning: true, idle: true))
        #expect(!IllustratorAuto.shouldRender(appRunning: false, idle: true))
        #expect(!IllustratorAuto.shouldRender(appRunning: true, idle: false))
    }
}
