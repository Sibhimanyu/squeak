import CoreGraphics
import Foundation
#if canImport(ImageIO)
import ImageIO
#endif

/// Where pictures sit in a transcript: the size a thumbnail takes (a pure function of the image's own size and the
/// limits, so a row's height never depends on whether the image has loaded yet), how several wrap in rows, and which
/// pictures a step must not repeat because the person attached them to a message in the turn.
public enum PictureLayout {
    /// A picture in a message bubble or a steer card.
    public static let bubbleMaxHeight: CGFloat = 160
    /// A picture a step read or wrote, shown inline and small.
    public static let stepMaxHeight: CGFloat = 60
    /// Squeak's `show_image` card.
    public static let cardMaxHeight: CGFloat = 160
    /// A steer card's pictures.
    public static let steerMaxHeight: CGFloat = 72
    public static let spacing: CGFloat = 8
    /// What a picture whose file cannot be read takes, so the row still has a shape.
    public static let fallback = CGSize(width: 96, height: 64)

    /// The image scaled to fit `maxWidth` x `maxHeight`, never enlarged. Nil or empty image sizes give `fallback`.
    public static func size(image: CGSize?, maxWidth: CGFloat, maxHeight: CGFloat) -> CGSize {
        guard let image, image.width > 0, image.height > 0 else {
            return CGSize(width: min(fallback.width, maxWidth), height: min(fallback.height, maxHeight))
        }
        let scale = min(1, maxHeight / image.height, maxWidth / image.width)
        return CGSize(width: max(1, (image.width * scale).rounded(.down)), height: max(1, (image.height * scale).rounded(.down)))
    }

    /// Thumbnails wrapped into rows no wider than `maxWidth`: each one's frame and the whole block's size.
    public static func rows(sizes: [CGSize], maxWidth: CGFloat, spacing: CGFloat = spacing) -> (frames: [CGRect], size: CGSize) {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for s in sizes {
            if x > 0, x + s.width > maxWidth { y += rowHeight + spacing; x = 0; rowHeight = 0 }
            frames.append(CGRect(x: x, y: y, width: s.width, height: s.height))
            x += s.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, s.height)
        }
        return (frames, CGSize(width: widest, height: sizes.isEmpty ? 0 : y + rowHeight))
    }

    /// A step's preview is left out when the picture is one the person attached in this turn: its label already says what
    /// it read, and the message shows the picture. A relative attachment path matches the absolute one that ends in it.
    public static func isAttached(_ path: String, attached: [String]) -> Bool {
        attached.contains { other in
            if other == path { return true }
            let (abs, rel) = path.hasPrefix("/") ? (path, other) : (other, path)
            guard abs.hasPrefix("/"), !rel.hasPrefix("/") else { return false }
            return abs.hasSuffix("/" + rel)
        }
    }

    /// Every picture path named by the given message texts.
    public static func attachedPaths(inTexts texts: [String]) -> [String] {
        texts.flatMap { ImageAttachments.split($0).paths }
    }

    #if canImport(ImageIO)
    nonisolated(unsafe) private static let dimensions: NSCache<NSString, NSValue> = { let c = NSCache<NSString, NSValue>(); c.countLimit = 400; return c }()

    /// The image's displayed pixel size from its header (orientation applied), without decoding it. Nil when unreadable.
    public static func pixelSize(ofFile path: String) -> CGSize? {
        if let hit = dimensions.object(forKey: path as NSString) { return hit.sizeValue }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue, w > 0, h > 0 else { return nil }
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let size = orientation >= 5 ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
        dimensions.setObject(NSValue(size: size), forKey: path as NSString)
        return size
    }
    #endif
}
