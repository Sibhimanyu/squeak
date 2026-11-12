import SwiftUI
import Testing
@testable import SqueakMarkup

@Suite("Path links")
struct PathLinkTests {
    static let inlines: [MessageMarkup.Inline] = [.text("See "), .code("src/a.ts:12"), .text(" and "), .code("nope.txt")]

    @Test func onlyAResolvedPathCarriesALinkAndTheTextIsUnchanged() {
        let ctx = RenderContext(style: MessageStyle.mac, scale: 1)
        let links = PathLinks(
            resolve: { $0 == "src/a.ts:12" ? URL(string: "squeak-path://open?p=x") : nil },
            menu: { _ in [] })
        let linked = InlineRenderer.attributed(Self.inlines, ctx: ctx, size: 14, weight: .regular, color: .primary, pathLinks: links)
        let plain = InlineRenderer.attributed(Self.inlines, ctx: ctx, size: 14, weight: .regular, color: .primary)
        // Copying the message gives the plain path: no characters were added or changed.
        #expect(String(linked.characters) == String(plain.characters))
        #expect(!String(linked.characters).contains("\u{200B}"))
        var withLink: [String] = []
        for run in linked.runs where run.link != nil { withLink.append(String(linked[run.range].characters)) }
        #expect(withLink == ["src/a.ts:12"])
        #expect(plain.runs.allSatisfy { $0.link == nil })
    }

    @Test func codePathsListsInlineCodeOncePerText() {
        #expect(InlineText.codePaths(in: Self.inlines + [.bold([.code("src/a.ts:12")])]) == ["src/a.ts:12", "nope.txt"])
    }
}
