import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ArtifactTabMenuTests {
    @Test func canvasGetsPdfAndPngThenRevealAndCopy() {
        let g = ArtifactTabMenu.groups(kind: .canvas)
        #expect(g.count == 3)
        #expect(g[0] == [.pdfAllBoards])
        #expect(g[1].count == 4)
        #expect(g[2] == [.reveal, .copyPath])
    }

    @Test func otherKindsOnlySaveACopy() {
        for kind in [ArtifactKind.pdf, .page, .image, .slides] {
            let all = ArtifactTabMenu.groups(kind: kind).flatMap { $0 }
            #expect(all == [.saveCopy, .reveal, .copyPath], "\(kind)")
        }
    }

    @Test func emptyCanvasKeepsOnlyFinderAndPath() {
        #expect(ArtifactTabMenu.groups(kind: .canvas, canExportCanvas: false) == [[.reveal, .copyPath]])
    }

    @Test func noFileNoMenu() {
        #expect(ArtifactTabMenu.groups(kind: .pdf, fileAvailable: false).isEmpty)
    }

    @Test func titlesFitOneLine() {
        #expect(ArtifactTabMenu.Entry.png(scale: .two, allBoards: true).title == "All artboards as PNG at 2x\u{2026}")
        #expect(ArtifactTabMenu.Entry.png(scale: .one, allBoards: false).title == "This artboard as PNG at 1x\u{2026}")
    }

    @Test func duckLabel() {
        #expect(ArtifactTabMenu.duckLabel(ArtifactItem(path: "a", duckName: " Pip ")) == "Pip")
        #expect(ArtifactTabMenu.duckLabel(ArtifactItem(path: "a")) == nil)
        #expect(ArtifactTabMenu.copyName(path: "/x/y/Deck.pdf") == "Deck.pdf")
    }
}
