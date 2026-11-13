import CoreGraphics

/// Inline code's chip geometry and classification, pure so it is tested without a text view.
public enum InlineChip {
    public enum Kind: Int, Sendable {
        /// Plain code: ink text.
        case code = 0
        /// A path the app can open: the same chip, text tinted, underlined only under the pointer.
        case path = 1
    }

    /// A path that resolved to a file or folder is a path chip; every other span is code.
    public static func kind(isLinkedPath: Bool) -> Kind { isLinkedPath ? .path : .code }

    public static let cornerRadius: CGFloat = 4.5
    public static let horizontalPadding: CGFloat = 4
    public static let verticalPadding: CGFloat = 1

    /// One line of a (possibly wrapped) run: where its glyphs start, how wide they are, the baseline, and the container's width.
    public struct Fragment: Equatable, Sendable {
        public var x: CGFloat, width: CGFloat, baselineY: CGFloat, containerWidth: CGFloat
        public init(x: CGFloat, width: CGFloat, baselineY: CGFloat, containerWidth: CGFloat) {
            self.x = x; self.width = width; self.baselineY = baselineY; self.containerWidth = containerWidth
        }
    }

    /// The chip boxes: font height plus the vertical padding, hung on the baseline (so it lines up with the sentence); the
    /// first line gets the leading padding (the trailing one is the kern on the run's last glyph); never outside the container.
    public static func rects(fragments: [Fragment], ascender: CGFloat, descender: CGFloat) -> [CGRect] {
        fragments.enumerated().map { n, f in
            let minX = max(0, f.x - (n == 0 ? horizontalPadding : 0))
            let maxX = min(f.containerWidth, f.x + f.width)
            return CGRect(
                x: minX, y: f.baselineY - ascender - verticalPadding,
                width: max(0, maxX - minX), height: ascender - descender + 2 * verticalPadding)
        }
    }
}
