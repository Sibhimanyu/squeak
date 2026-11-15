import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Markdown preview")
struct MarkdownPreviewTests {
    @Test func markdownExtensionsGetPreview() {
        #expect(MarkdownPreview.isMarkdown(path: ".context/handoff-2026-11-14.md"))
        #expect(MarkdownPreview.isMarkdown(path: "docs/A.MARKDOWN"))
        #expect(MarkdownPreview.isMarkdown(path: "page.mdx"))
        #expect(!MarkdownPreview.isMarkdown(path: "notes.txt"))
        #expect(!MarkdownPreview.isMarkdown(path: "md"))
    }

    @Test func previewFirstEditIsSourceAndChoiceSurvivesEdit() {
        #expect(MarkdownPreview.mode(editing: false, choice: nil) == .preview)
        #expect(MarkdownPreview.mode(editing: true, choice: nil) == .source)
        #expect(MarkdownPreview.mode(editing: true, choice: .preview) == .source)
        #expect(MarkdownPreview.mode(editing: false, choice: .source) == .source)
        #expect(MarkdownPreview.showsPreview(path: "a.md", editing: false, choice: nil))
        #expect(!MarkdownPreview.showsPreview(path: "a.md", editing: true, choice: .preview))
        #expect(!MarkdownPreview.showsPreview(path: "a.txt", editing: false, choice: nil))
    }

    @Test func relativeImagesResolveAgainstTheFilesFolder() {
        let file = URL(fileURLWithPath: "/w/docs/guide.md")
        #expect(MarkdownPreview.localImageURL(source: "img/a%20b.png", fileURL: file)?.path == "/w/docs/img/a b.png")
        #expect(MarkdownPreview.localImageURL(source: "../x.png", fileURL: file)?.path == "/w/x.png")
        #expect(MarkdownPreview.localImageURL(source: "https://e.com/x.png", fileURL: file) == nil)
        #expect(MarkdownPreview.localImageURL(source: "data:image/png;base64,AA", fileURL: file) == nil)
    }

    @Test func imagesOutsideTheWorkspaceRootAreRefused() {
        let file = URL(fileURLWithPath: "/w/docs/guide.md")
        let root = URL(fileURLWithPath: "/w")
        #expect(MarkdownPreview.localImageURL(source: "../../etc/x.png", fileURL: file, root: root) == nil)
        #expect(MarkdownPreview.localImageURL(source: "/Users/me/secret.png", fileURL: file, root: root) == nil)
        #expect(MarkdownPreview.localImageURL(source: "../x.png", fileURL: file, root: root)?.path == "/w/x.png")
        #expect(MarkdownPreview.localImageURL(source: "/w/img/a.png", fileURL: file, root: root)?.path == "/w/img/a.png")
    }
}

@Suite struct MarkdownAnchorTests {
    let doc = "# Title\n\nIntro paragraph.\n\n## Section A\n\ntext a1\ntext a2\n\n```swift\nlet x = 1\nlet y = 2\n```\n\n## Section B\n\ntext b1"
    var lineCount: Int { doc.split(separator: "\n", omittingEmptySubsequences: false).count }

    @Test func topOfFileIsZeroAndMonotonic() {
        #expect(MarkdownAnchor.fraction(ofLine: 1, in: doc) == 0)
        var last = -1.0
        for l in 1...lineCount {
            let f = MarkdownAnchor.fraction(ofLine: l, in: doc)
            #expect(f >= last)
            last = f
        }
        #expect(last < 1.0001)
    }

    @Test func lineAndFractionRoundTripLandOnTheSameLine() {
        for l in 1...lineCount {
            #expect(MarkdownAnchor.line(atFraction: MarkdownAnchor.fraction(ofLine: l, in: doc), in: doc) == l)
        }
    }

    @Test func aHeadingWeighsMoreThanABlankLineAndAnImageMoreThanBoth() {
        let w = MarkdownAnchor.weights("# H\n\n![a](b.png)\ntext")
        #expect(w[0] > w[1])
        #expect(w[2] > w[0])
    }

    @Test func fencedHashesAreNotHeadings() {
        #expect(MarkdownAnchor.heading(atOrAbove: 12, in: doc)?.title == "Section A")
        #expect(MarkdownAnchor.heading(atOrAbove: 3, in: doc)?.title == "Title")
        #expect(MarkdownAnchor.heading(atOrAbove: 5, in: "# Real\n```\n# not a heading\n```\ntext")?.title == "Real")
    }

    @Test func emptyAndPastTheEnd() {
        #expect(MarkdownAnchor.line(atFraction: 0.5, in: "") == 1)
        #expect(MarkdownAnchor.line(atFraction: 1, in: doc) == lineCount)
        #expect(abs(MarkdownAnchor.fraction(ofLine: 999, in: doc) - 1) < 1e-9)
    }
}
