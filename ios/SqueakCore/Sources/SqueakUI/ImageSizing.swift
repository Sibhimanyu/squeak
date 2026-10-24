import CoreGraphics

/// How big a picture sits in the chat. Pure, so the shape it keeps is tested.
public enum ImageSizing {
    /// The tallest an inline picture may be, as a share of the screen's height.
    public static let maxHeightFraction: CGFloat = 0.6
    /// The size for a picture of `natural` points in a space at most `maxWidth` by `maxHeight`: its own
    /// aspect ratio always, shrunk to fit, never enlarged past its own size (a small icon stays small).
    public static func fit(natural: CGSize, maxWidth: CGFloat, maxHeight: CGFloat) -> CGSize {
        guard natural.width > 0, natural.height > 0, maxWidth > 0, maxHeight > 0,
              natural.width.isFinite, natural.height.isFinite, maxWidth.isFinite, maxHeight.isFinite else { return .zero }
        let scale = min(1, maxWidth / natural.width, maxHeight / natural.height)
        return CGSize(width: (natural.width * scale).rounded(.down), height: (natural.height * scale).rounded(.down))
    }
}
