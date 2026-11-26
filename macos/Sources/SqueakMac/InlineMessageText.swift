import SqueakIcons
import SqueakMacCore
import SwiftUI

/// A sent message whose pictures sit inside its words (`InlineAttachments`): each token drawn as the same chip the composer
/// showed, where it was typed, so what you sent looks like what you wrote. A click on a chip opens the picture in Quick Look.
/// The words wrap word by word around the chips; line breaks are kept.
struct InlineMessageText: View {
    let text: String
    /// The chat's folder: a token's path is relative to it.
    var folder: String?
    var font: Font = Typo.reading
    var color: Color = Theme.ink
    @State private var source: InlineChipSource

    init(text: String, folder: String?, font: Font = Typo.reading, color: Color = Theme.ink) {
        self.text = text
        self.folder = folder
        self.font = font
        self.color = color
        _source = State(initialValue: InlineChipSource(folder: folder))
    }

    var body: some View {
        WordFlow(lineSpacing: 4) {
            ForEach(Array(InlineAttachments.pieces(text).enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .word(let w): Text(verbatim: w).font(font).foregroundStyle(color).fixedSize()
                case .newline: Color.clear.frame(width: 0, height: 0).layoutValue(key: WordFlowBreak.self, value: true)
                case .token(let t): InlineChipView(token: t, source: source)
                }
            }
        }
        .onChange(of: folder) { _, f in source.folder = f }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(InlineAttachments.segments(text).map {
            switch $0 {
            case .text(let t): t
            case .token(let t): " picture \(t.name) "
            }
        }.joined())
    }
}

/// One chip in a sent message: the thumbnail and the name on a `selected` pill, 22pt, like the composer's.
struct InlineChipView: View {
    let token: InlineAttachments.Token
    let source: InlineChipSource
    @State private var hovering = false

    var body: some View {
        Button { source.open(token) } label: {
            HStack(spacing: 6) {
                Group {
                    if let image = source.thumb(token) {
                        Image(nsImage: image).resizable().scaledToFill()
                    } else {
                        Image(systemName: token.isImage ? "photo" : "doc").font(.system(size: 10)).foregroundStyle(Theme.muted)
                    }
                }
                .frame(width: 16, height: 16)
                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                Text(verbatim: InlineAttachments.chipName(token.name)).font(.system(size: 12)).foregroundStyle(Theme.ink).lineLimit(1)
            }
            .padding(.leading, 4).padding(.trailing, 8).frame(height: 22)
            .background(Theme.selectedStrong.opacity(hovering ? 1 : 0.85), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain).pointerHand()
        .onHover { hovering = $0 }
        .help("Show \(token.name)")
        .accessibilityLabel("Picture \(token.name). Press to show")
    }
}

struct WordFlowBreak: LayoutValueKey { static let defaultValue = false }

/// Lays words and chips out left to right, wrapping at the width it is given; a `WordFlowBreak` starts a new line.
/// Items on a line share a centre line, so a 22pt chip sits level with the text beside it.
struct WordFlow: Layout {
    var lineSpacing: CGFloat = 4

    private func rows(_ subviews: Subviews, width: CGFloat) -> [[(Int, CGSize)]] {
        var rows: [[(Int, CGSize)]] = [[]]
        var x: CGFloat = 0
        for (i, v) in subviews.enumerated() {
            if v[WordFlowBreak.self] { rows.append([]); x = 0; continue }
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { rows.append([]); x = 0 }
            rows[rows.count - 1].append((i, s))
            x += s.width
        }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rs = rows(subviews, width: width)
        let w = rs.map { $0.reduce(0) { $0 + $1.1.width } }.max() ?? 0
        let h = rs.map { $0.map(\.1.height).max() ?? 17 }.reduce(0, +) + lineSpacing * CGFloat(max(0, rs.count - 1))
        return CGSize(width: min(w, width), height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for v in subviews where v[WordFlowBreak.self] { v.place(at: bounds.origin, proposal: .zero) }
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            let h = row.map(\.1.height).max() ?? 17
            var x = bounds.minX
            for (i, s) in row {
                subviews[i].place(at: CGPoint(x: x, y: y + (h - s.height) / 2), proposal: ProposedViewSize(s))
                x += s.width
            }
            y += h + lineSpacing
        }
    }
}
