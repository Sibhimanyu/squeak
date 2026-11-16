import SwiftUI

/// The non-moving status marks both apps share: waiting (a count or a solid dot), failed (circle-x), unread (a small
/// dot). Moving work is `TideGlyph`. The caller passes the colour.
public struct StatusMark: View {
    public enum Kind: Sendable, Equatable { case waiting(count: Int?), failed, unread }

    /// Dot diameter as a share of the mark's size.
    static func dotFraction(_ kind: Kind) -> CGFloat {
        switch kind { case .waiting: 0.40; case .unread: 0.30; case .failed: 1 }
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
            case .waiting, .unread:
                Circle().fill(color).frame(width: size * Self.dotFraction(kind), height: size * Self.dotFraction(kind))
            case .failed:
                Lucide(.circleX, size: size, color: color)
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}
