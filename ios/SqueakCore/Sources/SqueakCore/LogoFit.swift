import Foundation

/// How a project's logo sits in the Home list's circle, decided by the logo's own shape: a logo whose
/// artwork reaches its image's corners would lose them to a circular clip, so it is drawn smaller.
public struct LogoFit: Equatable, Sendable {
    /// Of the circle's diameter. 1 = the image fills the circle (its half side is the radius).
    public var scale: CGFloat
    /// The logo's own ground (r, g, b in 0...1), or nil when its corners are transparent or disagree.
    public var background: Ground?

    public struct Ground: Equatable, Sendable {
        public var r: Double, g: Double, b: Double
        public init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
    }

    public init(scale: CGFloat, background: Ground?) {
        self.scale = scale
        self.background = background
    }

    public static let unchanged = LogoFit(scale: 1, background: nil)

    /// The breathing gap: artwork may reach this fraction of the circle's radius.
    public static let margin: CGFloat = 0.90
    /// A guard: never shrink below this, whatever the artwork does.
    public static let minimumScale: CGFloat = 0.55

    private static let transparentAlpha = 0.1 * 255.0
    /// Euclidean RGB distance (0...441) past which an opaque pixel differs from the ground.
    private static let colourTolerance = 40.0
    private static let cornerAgreement = 24.0

    /// `rgba`: 4 bytes a pixel, rows top to bottom, `width * height * 4` bytes.
    /// Non-square images are measured against the shorter side: the image is drawn at that side's scale,
    /// centred, with the longer axis left uncropped, so no artwork is clipped by the image itself.
    public static func compute(rgba: [UInt8], width: Int, height: Int) -> LogoFit {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return .unchanged }
        func px(_ x: Int, _ y: Int) -> (r: Double, g: Double, b: Double, a: Double) {
            let i = (y * width + x) * 4
            return (Double(rgba[i]), Double(rgba[i + 1]), Double(rgba[i + 2]), Double(rgba[i + 3]))
        }
        let corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)]
        // Two transparent corners are enough: artwork may fill the others. A ground needs three that agree, so
        // artwork touching one corner does not hide it.
        let transparent = corners.filter { $0.a < transparentAlpha }.count >= 2
        var ground: (r: Double, g: Double, b: Double)?
        if !transparent {
            for seed in corners where seed.a >= transparentAlpha {
                let same = corners.filter { $0.a >= transparentAlpha && dist($0.r, $0.g, $0.b, seed.r, seed.g, seed.b) <= cornerAgreement }
                if same.count >= 3 {
                    let n = Double(same.count)
                    ground = (same.map(\.r).reduce(0, +) / n, same.map(\.g).reduce(0, +) / n, same.map(\.b).reduce(0, +) / n)
                    break
                }
            }
        }
        let half = Double(min(width, height)) / 2
        let cx = Double(width) / 2, cy = Double(height) / 2
        var farthest = 0.0
        var found = false
        for y in 0..<height {
            for x in 0..<width {
                let p = px(x, y)
                let isArt: Bool
                if transparent { isArt = p.a >= transparentAlpha }
                else if let g = ground { isArt = p.a >= transparentAlpha && dist(p.r, p.g, p.b, g.r, g.g, g.b) > colourTolerance }
                else { isArt = true }  // no detectable ground: the whole image is the artwork
                guard isArt else { continue }
                found = true
                // The pixel's far corner counts, so a pixel touching the edge reaches the edge.
                let dx = max(abs(Double(x) - cx), abs(Double(x) + 1 - cx))
                let dy = max(abs(Double(y) - cy), abs(Double(y) + 1 - cy))
                farthest = max(farthest, (dx * dx + dy * dy).squareRoot())
            }
        }
        let bg = ground.map { Ground(r: $0.r / 255, g: $0.g / 255, b: $0.b / 255) }
        guard found, farthest > 0 else { return LogoFit(scale: 1, background: bg) }
        let reach = farthest / half
        let scale = min(1, max(Double(minimumScale), Double(margin) / reach))
        return LogoFit(scale: CGFloat(scale), background: bg)
    }

    private static func dist(_ r1: Double, _ g1: Double, _ b1: Double, _ r2: Double, _ g2: Double, _ b2: Double) -> Double {
        ((r1 - r2) * (r1 - r2) + (g1 - g2) * (g1 - g2) + (b1 - b2) * (b1 - b2)).squareRoot()
    }
}
