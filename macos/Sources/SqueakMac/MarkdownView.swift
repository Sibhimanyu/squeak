import SqueakMacCore
import SwiftUI

/// Renders `MessageMarkup` blocks. Text is built by hand (never `AttributedString(markdown:)`),
/// links are shown as text plus their address in a muted style and are never clickable.
struct MarkdownView: View {
    let text: String
    var size: CGFloat = 13
    /// Extra leading: 14pt text at 1.45 line height.
    var lineSpacing: CGFloat { size * 0.26 }

    var body: some View {
        let blocks = MessageMarkup.parse(text)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                row(block)
                    .padding(.top, i == 0 ? 0 : gap(blocks[i - 1], block))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    /// Items of one list sit close together; everything else gets paragraph spacing.
    private func gap(_ a: MessageMarkup.Block, _ b: MessageMarkup.Block) -> CGFloat {
        if case .listItem = a, case .listItem = b { return 5 }
        if case .heading = a { return 6 }
        if case .heading = b { return 16 }
        return 10
    }

    @ViewBuilder private func row(_ block: MessageMarkup.Block) -> some View {
        switch block {
        case .paragraph(let inlines):
            run(inlines, size: size)
        case .heading(let level, let inlines):
            run(inlines, size: level <= 2 ? 16 : 15, weight: .semibold)
        case .listItem(let marker, let depth, let inlines):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: marker.label)
                    .font(.system(size: size, design: .default).monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 16, alignment: .trailing)
                run(inlines, size: size)
            }
            .padding(.leading, 4 + CGFloat(depth) * 18)
        case .quote(let inlines):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Theme.subtle.opacity(0.5)).frame(width: 3)
                run(inlines, size: size, color: Theme.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .codeBlock(let language, let code):
            VStack(alignment: .leading, spacing: 0) {
                if let language {
                    Text(verbatim: language)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.subtle)
                        .padding(.horizontal, 14).padding(.top, 8)
                }
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(verbatim: code)
                        .font(.system(size: size - 1, design: .monospaced))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: true, vertical: true)
                        .lineSpacing(2)
                        .padding(.horizontal, 14).padding(.top, language == nil ? 12 : 6).padding(.bottom, 12)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceRaised.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func run(_ inlines: [MessageMarkup.Inline], size: CGFloat, weight: Font.Weight = .regular, color: Color = Theme.ink) -> some View {
        var style = Style(size: size, weight: weight, italic: false, color: color)
        style.bold = weight != .regular
        return Text(MarkdownView.attributed(inlines, style))
            .lineSpacing(size >= 15 ? 2 : lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
    }

    struct Style {
        var size: CGFloat
        var weight: Font.Weight
        var italic: Bool
        var color: Color
        var bold = false
    }

    static func attributed(_ inlines: [MessageMarkup.Inline], _ style: Style) -> AttributedString {
        var out = AttributedString()
        for inline in inlines {
            switch inline {
            case .text(let s):
                out += piece(s, style)
            case .bold(let inner):
                var st = style; st.weight = .semibold
                out += attributed(inner, st)
            case .italic(let inner):
                var st = style; st.italic = true
                out += attributed(inner, st)
            case .code(let s):
                var a = AttributedString(s)
                a.font = .system(size: style.size - 1, design: .monospaced)
                a.foregroundColor = style.color
                a.backgroundColor = Theme.surfaceRaised.opacity(0.7)
                out += a
            case .link(let label, let destination):
                var st = style; st.color = Theme.ink
                var l = attributed(label, st)
                l.underlineStyle = .single
                out += l
                var u = AttributedString(" (\(destination))")
                u.font = .system(size: style.size - 1)
                u.foregroundColor = Theme.subtle
                out += u
            }
        }
        return out
    }

    private static func piece(_ s: String, _ style: Style) -> AttributedString {
        var a = AttributedString(s)
        var font = Font.system(size: style.size, weight: style.weight)
        if style.italic { font = font.italic() }
        a.font = font
        a.foregroundColor = style.color
        return a
    }
}

private extension MessageMarkup.ListMarker {
    var label: String {
        switch self {
        case .bullet: "•"
        case .number(let n): "\(n)."
        }
    }
}
