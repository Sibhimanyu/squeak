import Foundation
import SqueakIcons
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// An agent's (or your own) message, set as a document: paragraphs, headings, lists, quotes,
/// code with a Copy button, and tables as a grid. Agent text is untrusted, so nothing here
/// opens a link or interprets HTML: a link is underlined words plus its host, and "Copy link"
/// is the only thing it offers.
public struct MessageText: View {
    private let markdown: String
    private let style: MessageStyle
    private let blocks: [MessageMarkup.Block]
    private let isLong: Bool

    @ScaledMetric(relativeTo: .body) private var dynamicScale: CGFloat = 1
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(markdown: String, style: MessageStyle = .mac) {
        self.markdown = markdown
        self.style = style
        self.blocks = ParseCache.blocks(markdown)
        var lines = 1
        for b in markdown.utf8 where b == 10 { lines += 1 }
        self.isLong = lines > style.collapseLines
    }

    private var ctx: RenderContext {
        RenderContext(style: style, scale: style.scalesWithDynamicType ? dynamicScale : 1)
    }

    private var collapsedHeight: CGFloat {
        (style.bodySize + style.lineSpacing + 2) * ctx.scale * 38
    }

    public var body: some View {
        let collapsed = isLong && !expanded
        VStack(alignment: .leading, spacing: 8) {
            BlockStack(blocks: blocks, ctx: ctx)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(maxHeight: collapsed ? collapsedHeight : nil, alignment: .top)
                .clipped()
                .mask(alignment: .top) {
                    if collapsed {
                        VStack(spacing: 0) {
                            Rectangle()
                            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 56)
                        }
                    } else {
                        Rectangle()
                    }
                }
            if isLong {
                Button { withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { expanded.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text(expanded ? "Show less" : "Show more")
                        Lucide(expanded ? .chevronUp : .chevronDown, size: 14, color: style.muted)
                    }
                    .font(.system(size: max(12, style.bodySize - 1) * ctx.scale, weight: .medium))
                    .foregroundStyle(style.muted)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Show less of this message" : "Show more of this message")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

/// Parsed messages by their text. A chat view is rebuilt on every change the phone or Mac
/// publishes (a send, each streamed step, every poll), and parsing a long message each
/// time is what made the iPhone stutter right after you sent something.
private enum ParseCache {
    final class Entry { let blocks: [MessageMarkup.Block]; init(_ b: [MessageMarkup.Block]) { blocks = b } }
    // NSCache is thread-safe and evicts under memory pressure.
    nonisolated(unsafe) static let cache: NSCache<NSString, Entry> = { let c = NSCache<NSString, Entry>(); c.countLimit = 64; return c }()

    static func blocks(_ markdown: String) -> [MessageMarkup.Block] {
        let key = markdown as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = MessageMarkup.parse(markdown)
        cache.setObject(Entry(blocks), forKey: key)
        return blocks
    }
}

// MARK: Rendering

struct RenderContext {
    let style: MessageStyle
    let scale: CGFloat
    var body: CGFloat { style.bodySize * scale }
    var code: CGFloat { style.codeSize * scale }
    func heading(_ level: Int) -> CGFloat {
        let sizes = style.headingSizes
        return sizes[min(max(level, 1), sizes.count) - 1] * scale
    }
    var leading: CGFloat { style.lineSpacing * scale }
}

private struct BlockStack: View {
    let blocks: [MessageMarkup.Block]
    let ctx: RenderContext

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                BlockView(block: block, ctx: ctx)
                    .padding(.top, i == 0 ? 0 : gap(blocks[i - 1], block))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Paragraph rhythm: 0.6em between paragraphs, a list's items close together,
    /// a heading with room above and little below.
    private func gap(_ a: MessageMarkup.Block, _ b: MessageMarkup.Block) -> CGFloat {
        let em = ctx.body
        switch (a, b) {
        case (.listItem(_, let da, _), .listItem(_, let db, _)): return em * (da == db ? 0.3 : 0.22)
        case (.heading, .heading): return em * 0.5
        case (.heading, _): return em * 0.4
        case (_, .heading): return em * 1.3
        case (.listItem, _), (_, .listItem): return em * 0.6
        case (_, .rule), (.rule, _): return em * 0.9
        case (.codeBlock, _), (_, .codeBlock), (.table, _), (_, .table), (.quote, _), (_, .quote): return em * 0.75
        default: return em * 0.6
        }
    }
}

private struct BlockView: View {
    let block: MessageMarkup.Block
    let ctx: RenderContext

    var body: some View {
        switch block {
        case .paragraph(let inlines):
            InlineText(inlines: inlines, ctx: ctx)
        case .heading(let level, let inlines):
            InlineText(inlines: inlines, ctx: ctx, size: ctx.heading(level), weight: .semibold)
                .accessibilityAddTraits(.isHeader)
        case .listItem(let marker, let depth, let inlines):
            ListRow(marker: marker, depth: depth, inlines: inlines, ctx: ctx)
        case .codeBlock(let language, let code):
            CodeBlockView(language: language, code: code, ctx: ctx)
        case .quote(let inner):
            HStack(alignment: .top, spacing: ctx.body * 0.75) {
                RoundedRectangle(cornerRadius: 1.5).fill(ctx.style.subtle.opacity(0.55)).frame(width: 3)
                BlockStack(blocks: inner, ctx: ctx).foregroundStyle(ctx.style.muted)
                    .environment(\.messageMuted, true)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().fill(ctx.style.line).frame(height: 1).padding(.vertical, 2)
        case .table(let header, let alignments, let rows):
            TableView(header: header, alignments: alignments, rows: rows, ctx: ctx)
        }
    }
}

private struct MutedKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    fileprivate var messageMuted: Bool {
        get { self[MutedKey.self] }
        set { self[MutedKey.self] = newValue }
    }
}

private struct ListRow: View {
    let marker: MessageMarkup.ListMarker
    let depth: Int
    let inlines: [MessageMarkup.Inline]
    let ctx: RenderContext

    var body: some View {
        let width = ctx.body * 1.5
        HStack(alignment: .firstTextBaseline, spacing: ctx.body * 0.3) {
            markerView.frame(width: width, alignment: .trailing)
            InlineText(inlines: inlines, ctx: ctx, struck: isDone)
        }
        .padding(.leading, CGFloat(depth) * ctx.body * 1.5)
    }

    private var isDone: Bool { if case .task(true) = marker { true } else { false } }

    @ViewBuilder private var markerView: some View {
        switch marker {
        case .bullet:
            Text(verbatim: depth == 0 ? "•" : depth == 1 ? "◦" : "▪︎")
                .font(.system(size: ctx.body, weight: .regular)).foregroundStyle(ctx.style.muted)
        case .number(let n):
            Text(verbatim: "\(n).").font(.system(size: ctx.body).monospacedDigit()).foregroundStyle(ctx.style.muted)
        case .task(let done):
            let side = ctx.body * 0.95
            ZStack {
                RoundedRectangle(cornerRadius: 3.5)
                    .strokeBorder(done ? ctx.style.ink : ctx.style.subtle, lineWidth: 1.25)
                if done { Lucide(.check, size: side * 0.75, color: ctx.style.ink) }
            }
            .frame(width: side, height: side)
            .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - ctx.body * 0.05 }
            .accessibilityLabel(done ? "Done" : "Not done")
        }
    }
}

// MARK: Inline text

private struct InlineText: View {
    let inlines: [MessageMarkup.Inline]
    let ctx: RenderContext
    var size: CGFloat? = nil
    var weight: Font.Weight = .regular
    var struck = false
    @Environment(\.messageMuted) private var muted

    var body: some View {
        let links = Self.links(in: inlines)
        let text = Text(InlineRenderer.attributed(inlines, ctx: ctx, size: size ?? ctx.body, weight: weight, color: muted ? ctx.style.muted : ctx.style.ink, struck: struck))
            .lineSpacing(ctx.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        if links.isEmpty {
            text
        } else {
            text.contextMenu {
                ForEach(Array(links.prefix(6).enumerated()), id: \.offset) { _, link in
                    Button(links.count == 1 ? "Copy link" : "Copy link: \(InlineRenderer.host(link))") { Clipboard.copy(link) }
                }
            }
        }
    }

    static func links(in inlines: [MessageMarkup.Inline]) -> [String] {
        var out: [String] = []
        for i in inlines {
            switch i {
            case .link(let label, let dest): out.append(dest); out += links(in: label)
            case .url(let u): out.append(u)
            case .bold(let x), .italic(let x), .strike(let x): out += links(in: x)
            default: break
            }
        }
        return out
    }
}

enum InlineRenderer {
    struct Pen {
        var size: CGFloat
        var weight: Font.Weight
        var italic = false
        var color: Color
        var strike = false
        var underline = false
    }

    static func attributed(_ inlines: [MessageMarkup.Inline], ctx: RenderContext, size: CGFloat, weight: Font.Weight, color: Color, struck: Bool = false) -> AttributedString {
        build(inlines, ctx: ctx, pen: Pen(size: size, weight: weight, color: struck ? ctx.style.muted : color, strike: struck))
    }

    static func host(_ destination: String) -> String {
        if let h = URL(string: destination)?.host, !h.isEmpty { return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h }
        return destination.count > 40 ? String(destination.prefix(39)) + "…" : destination
    }

    private static func build(_ inlines: [MessageMarkup.Inline], ctx: RenderContext, pen: Pen) -> AttributedString {
        var out = AttributedString()
        for inline in inlines {
            switch inline {
            case .text(let s):
                out += styled(s, pen)
            case .bold(let inner):
                var p = pen; p.weight = .semibold
                out += build(inner, ctx: ctx, pen: p)
            case .italic(let inner):
                var p = pen; p.italic = true
                out += build(inner, ctx: ctx, pen: p)
            case .strike(let inner):
                var p = pen; p.strike = true; p.color = ctx.style.muted
                out += build(inner, ctx: ctx, pen: p)
            case .code(let s):
                out += mono(s, ctx: ctx, pen: pen, underline: false)
            case .path(let s):
                out += mono(s, ctx: ctx, pen: pen, underline: false)
            case .url(let s):
                out += mono(s, ctx: ctx, pen: pen, underline: true)
            case .link(let label, let destination):
                var p = pen; p.underline = true
                out += build(label, ctx: ctx, pen: p)
                let h = host(destination)
                let labelText = String(out.characters)
                if !labelText.localizedCaseInsensitiveContains(h) {
                    var u = AttributedString(" \(h)")
                    u.font = .system(size: pen.size * 0.92, weight: .regular)
                    u.foregroundColor = ctx.style.muted
                    out += u
                }
            }
        }
        return out
    }

    private static func styled(_ s: String, _ pen: Pen) -> AttributedString {
        var a = AttributedString(s)
        var font = Font.system(size: pen.size, weight: pen.weight)
        if pen.italic { font = font.italic() }
        a.font = font
        a.foregroundColor = pen.color
        if pen.strike { a.strikethroughStyle = .single }
        if pen.underline { a.underlineStyle = .single }
        return a
    }

    private static func mono(_ s: String, ctx: RenderContext, pen: Pen, underline: Bool) -> AttributedString {
        var a = AttributedString(s)
        a.font = .system(size: max(pen.size - 1, pen.size * 0.9), weight: pen.weight == .regular ? .regular : .medium, design: .monospaced)
        a.foregroundColor = pen.color
        a.backgroundColor = ctx.style.codeSurface
        if underline || pen.underline { a.underlineStyle = .single }
        if pen.strike { a.strikethroughStyle = .single }
        return a
    }
}

// MARK: Code

private struct CodeBlockView: View {
    let language: String?
    let code: String
    let ctx: RenderContext

    private var singleLine: Bool { language == nil && !code.contains("\n") }

    var body: some View {
        Group {
            if singleLine {
                HStack(spacing: 0) {
                    codeText.padding(.leading, 12).padding(.vertical, 9)
                    CopyButton(text: code, ctx: ctx, label: "Copy code")
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        Text(verbatim: language ?? "")
                            .font(.system(size: max(11, ctx.body * 0.85), weight: .medium, design: .monospaced))
                            .foregroundStyle(ctx.style.muted)
                            .padding(.leading, 12)
                        Spacer(minLength: 8)
                        CopyButton(text: code, ctx: ctx, label: "Copy code")
                    }
                    .frame(height: 30)
                    codeText.padding(.horizontal, 12).padding(.bottom, 11).padding(.top, 1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ctx.style.codeSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ctx.style.line))
        .accessibilityElement(children: .contain)
    }

    private var codeText: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(verbatim: code.isEmpty ? " " : code)
                .font(.system(size: ctx.code, design: .monospaced))
                .foregroundStyle(ctx.style.ink)
                .lineSpacing(ctx.code * 0.3)
                .fixedSize(horizontal: true, vertical: true)
                .textSelection(.enabled)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

/// Copies the code only, and only when tapped.
private struct CopyButton: View {
    let text: String
    let ctx: RenderContext
    let label: String
    @State private var copied = false

    var body: some View {
        Button {
            Clipboard.copy(text)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.6))
                copied = false
            }
        } label: {
            Lucide(copied ? .check : .copy, size: 15, color: ctx.style.muted)
                .frame(width: 40, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : label)
    }
}

enum Clipboard {
    static func copy(_ string: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #else
        UIPasteboard.general.string = string
        #endif
    }
}

// MARK: Tables

private struct TableView: View {
    let header: [[MessageMarkup.Inline]]
    let alignments: [MessageMarkup.Alignment]
    let rows: [[[MessageMarkup.Inline]]]
    let ctx: RenderContext

    var body: some View {
        // Prefer a table that fits the width, wrapping long cells; scroll only when it cannot.
        ViewThatFits(in: .horizontal) {
            grid(cellMax: nil)
            grid(cellMax: 14)
            grid(cellMax: 9)
            ScrollView(.horizontal, showsIndicators: false) { grid(cellMax: 14) }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
    }

    private func grid(cellMax: CGFloat?) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(header.enumerated()), id: \.offset) { i, cell in
                    cellView(cell, column: i, isHeader: true, cellMax: cellMax)
                        .background(ctx.style.tableHeader)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Rectangle().fill(ctx.style.line).frame(height: 1).gridCellColumns(max(header.count, 1))
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { i, cell in
                        cellView(cell, column: i, isHeader: false, cellMax: cellMax)
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ctx.style.line))
    }

    private func cellView(_ inlines: [MessageMarkup.Inline], column: Int, isHeader: Bool, cellMax: CGFloat?) -> some View {
        let align = column < alignments.count ? alignments[column] : .leading
        let frameAlign: Alignment = align == .center ? .center : align == .trailing ? .trailing : .leading
        let size = ctx.body * 0.96
        return Text(InlineRenderer.attributed(inlines, ctx: ctx, size: size, weight: isHeader ? .semibold : .regular, color: ctx.style.ink))
            .multilineTextAlignment(align == .center ? .center : align == .trailing ? .trailing : .leading)
            .lineSpacing(ctx.leading * 0.6)
            .fixedSize(horizontal: cellMax == nil, vertical: true)
            .frame(maxWidth: cellMax.map { ctx.body * $0 } ?? .infinity, alignment: frameAlign)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .gridColumnAlignment(align == .center ? .center : align == .trailing ? .trailing : .leading)
    }
}

/// One run of inline formatting in a single `Text`, for a card's question line: bold, code and
/// paths are set, line breaks fold into spaces, and `.lineLimit` works as on any Text.
public struct MessageInlineText: View {
    private let inlines: [MessageMarkup.Inline]
    private let style: MessageStyle
    private let size: CGFloat?
    private let weight: Font.Weight
    @ScaledMetric(relativeTo: .body) private var dynamicScale: CGFloat = 1

    public init(markdown: String, style: MessageStyle = .mac, size: CGFloat? = nil, weight: Font.Weight = .regular) {
        let flat = markdown.replacingOccurrences(of: "\n", with: " ")
        self.inlines = MessageMarkup.parseInlines(flat)
        self.style = style; self.size = size; self.weight = weight
    }

    public var body: some View {
        let ctx = RenderContext(style: style, scale: style.scalesWithDynamicType ? dynamicScale : 1)
        Text(InlineRenderer.attributed(inlines, ctx: ctx, size: (size ?? style.bodySize) * ctx.scale, weight: weight, color: style.ink))
            .lineSpacing(ctx.leading)
    }
}
