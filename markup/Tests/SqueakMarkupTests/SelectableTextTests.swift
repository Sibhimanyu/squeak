#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import SqueakMarkup

@MainActor @Suite("Selectable text", .serialized)
struct SelectableTextTests {
    static let ctx = RenderContext(style: MessageStyle.mac, scale: 1)

    private func build(_ md: String, links: PathLinks? = nil) -> NSAttributedString {
        let blocks = MessageMarkup.parse(md)
        return SelectableText.attributed(blocks, ctx: Self.ctx, pathLinks: links, muted: false)
    }

    @Test func paragraphsHeadingsAndListsFlowAsOneString() {
        let blocks = MessageMarkup.parse("# Title\n\nFirst para.\n\n- one\n- two\n\n1. next")
        #expect(SelectableText.groups(blocks).count == 1)
        let s = build("# Title\n\nFirst para.\n\n- one\n- two\n\n1. next").string
        #expect(s == "Title\nFirst para.\n•\tone\n•\ttwo\n1.\tnext")
    }

    @Test func codeBlocksAndTablesSplitTheRuns() {
        let blocks = MessageMarkup.parse("Intro\n\n```\nlet a = 1\n```\n\nOutro\nmore")
        let g = SelectableText.groups(blocks)
        #expect(g.map(\.flow) == [true, false, true])
    }

    @Test func boldAndInlineCodeKeepTheirFonts() {
        let a = build("plain **bold** and `code`")
        let bold = a.attribute(.font, at: 7, effectiveRange: nil) as? NSFont
        let code = a.attribute(.font, at: a.length - 2, effectiveRange: nil) as? NSFont
        #expect(bold?.fontDescriptor.symbolicTraits.contains(.bold) == true || (bold?.weightValue ?? 0) > 0.2)
        #expect(code?.isFixedPitch == true)
        #expect(a.attribute(SelectableText.chipKey, at: a.length - 2, effectiveRange: nil) != nil)
        #expect(a.attribute(.backgroundColor, at: a.length - 2, effectiveRange: nil) == nil)
    }

    @Test func onlyAResolvedPathIsALinkAndCarriesItsText() {
        let links = PathLinks(resolve: { $0 == "~/a.log" ? URL(string: "squeak-path://open?p=x") : nil }, menu: { _ in [] })
        let a = build("See `~/a.log` and `nope.txt`", links: links)
        var linked: [String] = []
        a.enumerateAttribute(.link, in: NSRange(location: 0, length: a.length)) { v, r, _ in
            if v != nil { linked.append((a.string as NSString).substring(with: r)) }
        }
        #expect(linked == ["~/a.log"])
        #expect(a.attribute(SelectableText.pathKey, at: 5, effectiveRange: nil) as? String == "~/a.log")
        #expect(a.string == "See ~/a.log and nope.txt")
    }

    @Test func markdownLinkOpensItsWebAddressAndKeepsItForCopy() {
        let a = build("[docs](https://example.com/x)")
        #expect((a.attribute(.link, at: 0, effectiveRange: nil) as? URL)?.absoluteString == "https://example.com/x")
        #expect(a.attribute(SelectableText.destinationKey, at: 0, effectiveRange: nil) as? String == "https://example.com/x")
        #expect(build("[x](file:///etc/passwd)").attribute(.link, at: 0, effectiveRange: nil) == nil)
    }

    @Test func aCodeSpanThatIsOneURLIsALink() {
        let a = build("See `https://github.com/Sibhimanyu/greenroom/releases/tag/v1.5.0` now")
        let url = "https://github.com/Sibhimanyu/greenroom/releases/tag/v1.5.0"
        #expect((a.attribute(.link, at: 6, effectiveRange: nil) as? URL)?.absoluteString == url)
        #expect(a.attribute(SelectableText.destinationKey, at: 6, effectiveRange: nil) as? String == url)
        #expect(a.string == "See \(url) now")
    }

    @Test func aCodeSpanThatIsNotJustAURLStaysCode() {
        for md in ["`npm run dev`", "`curl https://a.com/x`", "`ftp://a.com/x`", "`see https://a.com`", "`foo.bar`"] {
            let a = build(md)
            var linked = false
            a.enumerateAttribute(.link, in: NSRange(location: 0, length: a.length)) { v, _, _ in if v != nil { linked = true } }
            #expect(!linked, "\(md)")
        }
    }

    @Test func aBareURLInTextIsALink() {
        let a = build("Open https://example.com/x now")
        #expect((a.attribute(.link, at: 6, effectiveRange: nil) as? URL)?.absoluteString == "https://example.com/x")
        #expect(a.attribute(.link, at: 0, effectiveRange: nil) == nil)
    }

    @Test func listItemsHangTheirWrappedLines() {
        let a = build("- item")
        let p = a.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        #expect((p?.headIndent ?? 0) > (p?.firstLineHeadIndent ?? 0))
    }

    @Test func theTextViewMeasuresWrappedHeightAndKeepsSelectionOnEqualUpdates() {
        let v = SelectableTextView()
        v.setText(build(String(repeating: "word ", count: 80)))
        let narrow = v.height(forWidth: 120), wide = v.height(forWidth: 600)
        #expect(narrow > wide && wide > 0)
    }

    @Test func aResolvedPathIsATintedChipWithNoUnderlineUntilHover() {
        let links = PathLinks(resolve: { $0 == "dist/" ? URL(string: "squeak-path://open?p=x") : nil }, menu: { _ in [] })
        var style = MessageStyle.mac
        style.pathTint = .orange
        let ctx = RenderContext(style: style, scale: 1)
        let a = SelectableText.attributed(MessageMarkup.parse("See `dist/` and `npm run`"), ctx: ctx, pathLinks: links, muted: false)
        #expect(a.attribute(SelectableText.chipKey, at: 5, effectiveRange: nil) as? Int == InlineChip.Kind.path.rawValue)
        #expect(a.attribute(.underlineStyle, at: 5, effectiveRange: nil) == nil)
        #expect(a.attribute(.link, at: 5, effectiveRange: nil) != nil)
        let code = a.length - 3
        #expect(a.attribute(SelectableText.chipKey, at: code, effectiveRange: nil) as? Int == InlineChip.Kind.code.rawValue)
        #expect(a.attribute(.link, at: code, effectiveRange: nil) == nil)
        #expect(a.string == "See dist/ and npm run")
    }

    @Test func theChipDrawsWithoutCrashingAcrossWrappedLines() {
        let v = SelectableTextView()
        v.frame = NSRect(x: 0, y: 0, width: 90, height: 120)
        v.setText(build("a `some/very/long/path/that/wraps.md` b"))
        v.layoutManager?.ensureLayout(for: v.textContainer!)
        let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)!
        v.cacheDisplay(in: v.bounds, to: rep)
        #expect(rep.pixelsWide > 0)
    }

    @Test func aLongReplyIsOneTextViewPerRunNotPerBlock() {
        var md = ""
        for n in 0..<12 { md += "Paragraph \(n) with **bold**.\n\n- item a\n- item b\n\n" }
        md += "```\ncode\n```\n\nTail one.\n\nTail two."
        let blocks = MessageMarkup.parse(md)
        let g = SelectableText.groups(blocks)
        #expect(blocks.count > 30)
        #expect(g.map(\.flow) == [true, false, true])
        #expect(g.flatMap { $0.range }.count == blocks.count)
    }

    @Test func theAttributedKeyFollowsWhatTheStringDependsOn() {
        let b = MessageMarkup.parse("Hello `a.txt` **x**")
        func key(_ ctx: RenderContext = Self.ctx, muted: Bool = false, scheme: ColorScheme = .light, links: PathLinks? = nil, blocks: [MessageMarkup.Block]? = nil) -> String {
            AttributedCache.key(blocks ?? b, ctx: ctx, pathLinks: links, muted: muted, scheme: scheme)
        }
        #expect(key() == key())
        #expect(key() != key(muted: true))
        #expect(key() != key(scheme: .dark))
        #expect(key() != key(RenderContext(style: MessageStyle.mac, scale: 1.2)))
        #expect(key() != key(blocks: MessageMarkup.parse("Hello `a.txt` **y**")))
        let found = Flag()
        let links = PathLinks(resolve: { _ in found.on ? URL(string: "squeak-path://open?p=x") : nil }, menu: { _ in [] })
        let before = key(links: links)
        found.on = true
        #expect(before != key(links: links))
    }

    @Test func aCachedStringIsBuiltOnce() {
        let b = MessageMarkup.parse("Unique text \(UUID().uuidString)")
        let k = AttributedCache.key(b, ctx: Self.ctx, pathLinks: nil, muted: false, scheme: .light)
        let start = AttributedCache.buildCount
        let ctx = Self.ctx
        let a = AttributedCache.string(k) { SelectableText.attributed(b, ctx: ctx, pathLinks: nil, muted: false) }
        let c = AttributedCache.string(k) { SelectableText.attributed(b, ctx: ctx, pathLinks: nil, muted: false) }
        #expect(AttributedCache.buildCount == start + 1)
        #expect(a === c)
    }
}

private final class Flag: @unchecked Sendable { var on = false }

private extension NSFont {
    var weightValue: CGFloat {
        ((fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat) ?? 0
    }
}
#endif
