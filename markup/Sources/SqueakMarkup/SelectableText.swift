import Foundation
import SwiftUI
#if os(macOS)
import AppKit

/// One selectable text for a run of paragraphs, headings and list items (macOS). SwiftUI's `Text` selects only inside
/// one `Text`, so a message set as one `Text` per block was a row of islands: a drag stopped at the paragraph's edge.
/// A run of those blocks is instead one attributed string in one `NSTextView`, so a drag, ⌘A, ⌘C and right-click Copy
/// work across all of it. Code blocks, tables, images, rules and quotes stay their own views (they are not text flow).
///
/// Why NSTextView and not `.openURL` on `Text`: a `Text` run has no pointer of its own and SwiftUI does not give
/// one to a link, whereas an NSTextView shows the pointing hand over any `.link` run by itself.
public enum SelectableText {
    /// The path as written, on a run that is a link (the menu asks the app what to offer for it).
    public static let pathKey = NSAttributedString.Key("squeak.path")
    /// A link's destination, on its label, for "Copy link". Never opened.
    public static let destinationKey = NSAttributedString.Key("squeak.destination")

    /// Blocks that flow as text in one view.
    public static func isFlowable(_ block: MessageMarkup.Block) -> Bool {
        switch block {
        case .paragraph, .heading, .listItem: true
        default: false
        }
    }

    /// Groups of consecutive blocks: a `true` group is a run of flowable blocks, a `false` group is one other block.
    public static func groups(_ blocks: [MessageMarkup.Block]) -> [(flow: Bool, range: Range<Int>)] {
        var out: [(Bool, Range<Int>)] = []
        var i = 0
        while i < blocks.count {
            if isFlowable(blocks[i]) {
                var j = i + 1
                while j < blocks.count, isFlowable(blocks[j]) { j += 1 }
                out.append((true, i..<j)); i = j
            } else { out.append((false, i..<(i + 1))); i += 1 }
        }
        return out
    }

    struct Pen {
        var size: CGFloat
        var weight: Font.Weight
        var italic = false
        var color: NSColor
        var strike = false
        var underline = false
        var pathLinks: PathLinks?
        var destination: String?
    }

    /// The attributed string for a run of flowable blocks (the others are skipped).
    static func attributed(_ blocks: [MessageMarkup.Block], ctx: RenderContext, pathLinks: PathLinks?, muted: Bool) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let base = NSColor(muted ? ctx.style.muted : ctx.style.ink)
        let flow = blocks.enumerated().filter { isFlowable($0.element) }
        for (n, entry) in flow.enumerated() {
            let block = entry.element
            let start = out.length
            let spacing = n + 1 < flow.count ? MessageLayout.gap(from: block, to: flow[n + 1].element, em: ctx.body, style: ctx.style) : 0
            let para = NSMutableParagraphStyle()
            para.lineSpacing = ctx.leading
            para.paragraphSpacing = spacing
            switch block {
            case .paragraph(let inlines):
                append(inlines, to: out, ctx: ctx, pen: Pen(size: ctx.body, weight: .regular, color: base, pathLinks: pathLinks))
            case .heading(let level, let inlines):
                append(inlines, to: out, ctx: ctx, pen: Pen(size: ctx.heading(level), weight: .semibold, color: base, pathLinks: pathLinks))
            case .listItem(let marker, let depth, let inlines):
                let (text, bold) = markerText(marker, depth: depth, ctx: ctx)
                let markerAttrs: [NSAttributedString.Key: Any] = [
                    .font: font(size: ctx.body, weight: bold ? .medium : .regular, italic: false, mono: false),
                    .foregroundColor: NSColor(ctx.style.muted),
                ]
                let markerString = NSAttributedString(string: text, attributes: markerAttrs)
                let column = ctx.body * ctx.style.listIndentEm
                let indent = CGFloat(depth) * column
                let contentStart = indent + column + ctx.body * 0.3
                para.firstLineHeadIndent = indent + max(0, column - markerString.size().width)
                para.headIndent = contentStart
                para.tabStops = [NSTextTab(textAlignment: .left, location: contentStart)]
                para.defaultTabInterval = 0
                out.append(markerString)
                out.append(NSAttributedString(string: "\t", attributes: markerAttrs))
                var struck = false
                if case .task(true) = marker { struck = true }
                var pen = Pen(size: ctx.body, weight: .regular, color: struck ? NSColor(ctx.style.muted) : base, strike: struck, pathLinks: pathLinks)
                pen.strike = struck
                append(inlines, to: out, ctx: ctx, pen: pen)
            default: break
            }
            if n + 1 < flow.count { out.append(NSAttributedString(string: "\n")) }
            out.addAttribute(.paragraphStyle, value: para, range: NSRange(location: start, length: out.length - start))
        }
        return out
    }

    private static func markerText(_ marker: MessageMarkup.ListMarker, depth: Int, ctx: RenderContext) -> (String, Bool) {
        switch marker {
        case .bullet: (ctx.style.solidBullets ? "•" : depth == 0 ? "•" : depth == 1 ? "◦" : "▪︎", false)
        case .letter(let l): ("\(l))", true)
        case .number(let n): ("\(n).", false)
        case .task(let done): (done ? "☑" : "☐", false)
        }
    }

    static func font(size: CGFloat, weight: Font.Weight, italic: Bool, mono: Bool) -> NSFont {
        let w: NSFont.Weight = weight == .semibold ? .semibold : weight == .medium ? .medium : weight == .bold ? .bold : .regular
        var f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: w) : NSFont.systemFont(ofSize: size, weight: w)
        if italic { f = NSFontManager.shared.convert(f, toHaveTrait: .italicFontMask) }
        return f
    }

    private static func append(_ inlines: [MessageMarkup.Inline], to out: NSMutableAttributedString, ctx: RenderContext, pen: Pen) {
        for inline in inlines {
            switch inline {
            case .text(let s):
                out.append(styled(s, pen))
            case .bold(let inner):
                var p = pen; p.weight = .semibold
                append(inner, to: out, ctx: ctx, pen: p)
            case .italic(let inner):
                var p = pen; p.italic = true
                append(inner, to: out, ctx: ctx, pen: p)
            case .strike(let inner):
                var p = pen; p.strike = true; p.color = NSColor(ctx.style.muted)
                append(inner, to: out, ctx: ctx, pen: p)
            case .code(let s), .path(let s):
                let shown = ctx.style.breakPaths ? MessageLayout.breakablePath(s) : s
                let piece = NSMutableAttributedString(attributedString: mono(shown, ctx: ctx, pen: pen, underline: false))
                if let url = pen.pathLinks?.resolve(s) {
                    let r = NSRange(location: 0, length: piece.length)
                    piece.addAttributes([.link: url, pathKey: s, .underlineStyle: NSUnderlineStyle.single.rawValue], range: r)
                }
                out.append(piece)
            case .url(let s):
                let piece = NSMutableAttributedString(attributedString: mono(s, ctx: ctx, pen: pen, underline: true))
                piece.addAttribute(destinationKey, value: s, range: NSRange(location: 0, length: piece.length))
                out.append(piece)
            case .link(let label, let destination):
                var p = pen; p.underline = true; p.destination = destination
                append(label, to: out, ctx: ctx, pen: p)
                let h = InlineRenderer.host(destination)
                if !out.string.localizedCaseInsensitiveContains(h) {
                    out.append(NSAttributedString(string: " \(h)", attributes: [
                        .font: NSFont.systemFont(ofSize: pen.size * 0.92, weight: .regular),
                        .foregroundColor: NSColor(ctx.style.muted),
                        destinationKey: destination,
                    ]))
                }
            }
        }
    }

    private static func styled(_ s: String, _ pen: Pen) -> NSAttributedString {
        var attrs: [NSAttributedString.Key: Any] = [
            .font: font(size: pen.size, weight: pen.weight, italic: pen.italic, mono: false),
            .foregroundColor: pen.color,
        ]
        if pen.strike { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if pen.underline { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if let d = pen.destination { attrs[destinationKey] = d }
        return NSAttributedString(string: s, attributes: attrs)
    }

    private static func mono(_ s: String, ctx: RenderContext, pen: Pen, underline: Bool) -> NSAttributedString {
        let size = ctx.style.inlineCodeScale.map { pen.size * $0 } ?? max(pen.size - 1, pen.size * 0.9)
        var attrs: [NSAttributedString.Key: Any] = [
            .font: font(size: size, weight: pen.weight == .regular ? .regular : .medium, italic: false, mono: true),
            .foregroundColor: pen.color,
            .backgroundColor: NSColor(ctx.style.codeSurface),
        ]
        if underline || pen.underline { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if pen.strike { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        return NSAttributedString(string: s, attributes: attrs)
    }
}

/// The run as one SwiftUI view. Its body builds the string, so a finished path check (which `resolve` reads) redraws it.
struct SelectableRun: View {
    let blocks: [MessageMarkup.Block]
    let ctx: RenderContext
    @Environment(\.messageMuted) private var muted
    @Environment(\.messagePathLinks) private var pathLinks
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    var body: some View {
        SelectableTextRepresentable(
            text: SelectableText.attributed(blocks, ctx: ctx, pathLinks: pathLinks, muted: muted),
            pathLinks: pathLinks, scheme: scheme, open: { openURL($0) })
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SelectableTextRepresentable: NSViewRepresentable {
    let text: NSAttributedString
    let pathLinks: PathLinks?
    let scheme: ColorScheme
    let open: (URL) -> Void

    func makeNSView(context: Context) -> SelectableTextView {
        let v = SelectableTextView()
        v.delegate = context.coordinator
        return v
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func updateNSView(_ v: SelectableTextView, context: Context) {
        context.coordinator.open = open
        v.pathLinks = pathLinks
        // Replace only what changed, so a selection survives a redraw (a streamed message re-renders often).
        if !v.currentText.isEqual(to: text) {
            let selected = v.selectedRange()
            v.setText(text)
            if NSMaxRange(selected) <= text.length { v.setSelectedRange(selected) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView v: SelectableTextView, context: Context) -> CGSize? {
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 480
        return CGSize(width: w, height: v.height(forWidth: w))
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var open: (URL) -> Void = { _ in }
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL { open(url) } else if let s = link as? String, let url = URL(string: s) { open(url) } else { return false }
            return true
        }
    }
}

/// Non-editable, selectable, transparent, sized to its text. ⌘C and the menu's Copy give the plain text with no wrap hints.
final class SelectableTextView: NSTextView {
    var pathLinks: PathLinks?
    private var measured: (width: CGFloat, height: CGFloat)?

    init() {
        // TextKit 1 on purpose: `layoutManager` gives a cheap, exact height and the link rects.
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(manager)
        manager.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        drawsBackground = false
        isRichText = true
        importsGraphics = false
        textContainerInset = .zero
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        isHorizontallyResizable = false
        isVerticallyResizable = false
        linkTextAttributes = [:]  // keep our colours; the pointing hand still shows over a link
        isAutomaticLinkDetectionEnabled = false
        isAutomaticDataDetectionEnabled = false
        setAccessibilityRole(.staticText)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }

    // A private layout stack for measuring, so a height never depends on what the view itself is doing.
    private let measureStorage = NSTextStorage()
    private let measureManager = NSLayoutManager()
    private let measureContainer = NSTextContainer(size: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))

    var currentText: NSAttributedString { textStorage ?? NSAttributedString() }

    func setText(_ text: NSAttributedString) {
        textStorage?.setAttributedString(text)
        measureStorage.setAttributedString(text)
        measured = nil
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        if let m = measured, m.width == width { return m.height }
        if measureStorage.layoutManagers.isEmpty {
            measureContainer.lineFragmentPadding = 0
            measureStorage.addLayoutManager(measureManager)
            measureManager.addTextContainer(measureContainer)
        }
        measureContainer.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        _ = measureManager.glyphRange(for: measureContainer)
        let h = ceil(measureManager.usedRect(for: measureContainer).height)
        measured = (width, h)
        return h
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if let c = textContainer, c.containerSize.width != newSize.width {
            c.containerSize = NSSize(width: newSize.width, height: CGFloat.greatestFiniteMagnitude)
            measured = nil
        }
    }

    override func copy(_ sender: Any?) {
        let r = selectedRange()
        guard r.length > 0 else { return }
        let text = MessageLayout.strippingWrapHints((string as NSString).substring(with: r))
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// One selection at a time: leaving a message clears its highlight.
    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok, selectedRange().length > 0 { setSelectedRange(NSRange(location: 0, length: 0)) }
        return ok
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        let point = convert(event.locationInWindow, from: nil)
        guard let manager = layoutManager, let container = textContainer, let storage = textStorage, storage.length > 0 else { return menu }
        var fraction: CGFloat = 0
        let glyph = manager.glyphIndex(for: point, in: container, fractionOfDistanceThroughGlyph: &fraction)
        let rect = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard rect.contains(point) else { return menu }
        let index = manager.characterIndexForGlyph(at: glyph)
        guard index < storage.length else { return menu }
        var items: [NSMenuItem] = []
        if let raw = storage.attribute(SelectableText.pathKey, at: index, effectiveRange: nil) as? String, let pathLinks {
            for entry in pathLinks.menu(raw) { items.append(Self.item(entry.title) { entry.run() }) }
        } else if let dest = storage.attribute(SelectableText.destinationKey, at: index, effectiveRange: nil) as? String {
            items.append(Self.item("Copy link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(dest, forType: .string)
            })
        }
        for (n, item) in items.enumerated() { menu.insertItem(item, at: n) }
        if !items.isEmpty { menu.insertItem(.separator(), at: items.count) }
        return menu
    }

    private final class Action: NSObject {
        let run: () -> Void
        init(_ run: @escaping () -> Void) { self.run = run }
        @objc func fire() { run() }
    }

    private static func item(_ title: String, _ run: @escaping () -> Void) -> NSMenuItem {
        let action = Action(run)
        let item = NSMenuItem(title: title, action: #selector(Action.fire), keyEquivalent: "")
        item.target = action
        item.representedObject = action  // the target is weak; this keeps it alive
        return item
    }
}
#endif
