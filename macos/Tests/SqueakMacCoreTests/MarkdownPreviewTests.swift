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
