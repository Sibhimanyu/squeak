import SwiftUI

/// The non-moving status marks both apps share: waiting (a count or the triangle-alert glyph), failed (circle-x),
/// unread (nothing: the row's title weight says it). Never a coloured dot (DESIGN.md §8.1). Moving work is
/// `TideGlyph`. The caller passes the colour.
public struct StatusMark: View {
    public enum Kind: Sendable, Equatable { case waiting(count: Int?), failed, unread }

    /// The glyph's share of the mark's size; unread draws nothing, so its slot stays empty.
    static func glyphFraction(_ kind: Kind) -> CGFloat {
        switch kind { case .waiting: 0.85; case .unread: 0; case .failed: 1 }
    }

    private let kind: Kind, color: Color, size: CGFloat

    public init(kind: Kind, color: Color, size: CGFloat) { self.kind = kind; self.color = color; self.size = size }

    public var body: some View {
        Group {
            switch kind {
            case .waiting(let count?) where count > 0:
                Text("\(count)")
                    .font(.system(size: size * 0.8, weight: .semibold, design: .monospaced))
                    .minimumScaleFactor(0.5).lineLimit(1)
                    .foregroundStyle(color)
            case .waiting:
                Lucide(.triangleAlert, size: size * Self.glyphFraction(kind), color: color)
            case .unread:
                Color.clear
            case .failed:
                Lucide(.circleX, size: size, color: color)
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}
