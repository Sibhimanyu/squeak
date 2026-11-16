import Foundation

// A pond's colour from its logo, as real colours (not hues). The caller hands over RGBA bytes (8 bits, row-major,
// about 32 by 32). Opaque pixels are grouped into a few distinct colours; white, black, grey and anti-aliased edge
// pixels are ignored, so a white "G" on a deep green square with a lime dot gives the green and the lime.

public enum LogoColours {
    public static let maxColours = 3
    /// Colours closer than this in sRGB (0...1 per channel, Euclidean) are one colour.
    public static let minDistance = 0.22

    public struct Colour: Equatable, Sendable {
        public var rgb: PondTint.RGB
        /// Share of the counted pixels (0...1).
        public var share: Double
        public var vividness: Double
    }

    /// Up to three dominant, distinct colours. The first is the accent: the most vivid one that covers at least 1.5% of
    /// the counted pixels (area only breaks near ties); the others follow by prominence. Empty for a greyscale or blank image.
    public static func colours(rgba: [UInt8], width: Int, height: Int) -> [Colour] {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return [] }
        func px(_ x: Int, _ y: Int) -> (Double, Double, Double, Double) {
            let i = (y * width + x) * 4
            return (Double(rgba[i]) / 255, Double(rgba[i + 1]) / 255, Double(rgba[i + 2]) / 255, Double(rgba[i + 3]) / 255)
        }
        func dist(_ a: (Double, Double, Double, Double), _ b: (Double, Double, Double, Double)) -> Double {
            let dr = a.0 - b.0, dg = a.1 - b.1, db = a.2 - b.2
            return (dr * dr + dg * dg + db * db).squareRoot()
        }
        // Pass 1 skips pixels beside a sharply different neighbour (an anti-aliased edge); if that leaves nothing
        // (a tiny or all-edge icon) pass 2 counts them.
        for skipEdges in [true, false] {
            var bins: [Int: (n: Double, r: Double, g: Double, b: Double)] = [:]
            var counted = 0.0
            for y in 0..<height {
                for x in 0..<width {
                    let p = px(x, y)
                    if p.3 < 0.9 { continue }
                    let mx = max(p.0, p.1, p.2), mn = min(p.0, p.1, p.2)
                    if mx < 0.12 || mn > 0.90 { continue }
                    if mx == 0 || (mx - mn) / mx < 0.15 { continue }
                    if skipEdges {
                        var edge = false
                        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                            let nx = x + dx, ny = y + dy
                            guard nx >= 0, ny >= 0, nx < width, ny < height else { continue }
                            if dist(p, px(nx, ny)) > 0.2 { edge = true; break }
                        }
                        if edge { continue }
                    }
                    let k = Int(p.0 * 15.99) << 8 | Int(p.1 * 15.99) << 4 | Int(p.2 * 15.99)
                    var b = bins[k] ?? (0, 0, 0, 0)
                    b.n += 1; b.r += p.0; b.g += p.1; b.b += p.2
                    bins[k] = b
                    counted += 1
                }
            }
            guard counted > 0 else { continue }
            // Greedy clusters over the bins, heaviest first, each joining the first cluster within `minDistance`.
            var clusters: [(n: Double, r: Double, g: Double, b: Double)] = []
            for b in bins.values.sorted(by: { $0.n > $1.n }) {
                let c = (b.r / b.n, b.g / b.n, b.b / b.n)
                if let i = clusters.firstIndex(where: { k in
                    let m = (k.r / k.n - c.0, k.g / k.n - c.1, k.b / k.n - c.2)
                    return (m.0 * m.0 + m.1 * m.1 + m.2 * m.2).squareRoot() < minDistance
                }) {
                    clusters[i].n += b.n; clusters[i].r += b.r; clusters[i].g += b.g; clusters[i].b += b.b
                } else {
                    clusters.append(b)
                }
            }
            let all = clusters.map { k -> Colour in
                let rgb = PondTint.RGB(r: k.r / k.n, g: k.g / k.n, b: k.b / k.n)
                let (_, s, v) = PondTint.hsv(rgb)
                return Colour(rgb: rgb, share: k.n / counted, vividness: s * v)
            }
            let byShare = all.sorted { $0.share > $1.share }
            let real = byShare.filter { $0.share >= 0.015 }
            let pool = real.isEmpty ? Array(byShare.prefix(1)) : real
            func score(_ c: Colour) -> Double { c.vividness * (1 + min(c.share, 0.2)) }
            guard let accent = pool.max(by: { score($0) < score($1) }) else { continue }
            let rest = pool.filter { $0 != accent }
            return Array(([accent] + rest).prefix(maxColours))
        }
        return []
    }
}

extension PondTint.RGB {
    /// `#rrggbb`, lower case.
    public var hexString: String {
        func b(_ v: Double) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", b(r), b(g), b(self.b))
    }

    /// Reads `#rrggbb` (any case); nil for anything else.
    public init?(hexString s: String) {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count == 7, t.hasPrefix("#"), let v = UInt32(t.dropFirst(), radix: 16) else { return nil }
        self.init(hex: v)
    }
}
