import Foundation

// DESIGN.md §3.1 and §8.10, the Pond colour pass: a soft tint per pond, stable from its id, and the people's avatar
// colours. Duck yellow is the accent (a fill in dark, `duck-text` where light needs text-grade contrast) and is
// never a state; so neither tint nor avatar colours land in the duck's band (hue 25 to 75). Pastels, in light and dark.

/// The colours a person can give a pond (the host's `POND_COLOURS`): a name and a hue in degrees.
public enum PondColours {
    public static let all: [(name: String, hue: Double)] = [
        ("red", 355), ("coral", 10), ("lime", 95), ("green", 140), ("teal", 175), ("cyan", 195),
        ("blue", 220), ("indigo", 245), ("violet", 270), ("purple", 295), ("pink", 325),
    ]
    public static func hue(named name: String?) -> Double? { all.first { $0.name == name }?.hue }
}

public enum PondTint {
    public struct RGB: Equatable, Sendable {
        public var r: Double, g: Double, b: Double
        public init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
        public init(hex: UInt32) {
            self.init(r: Double((hex >> 16) & 0xFF) / 255, g: Double((hex >> 8) & 0xFF) / 255, b: Double(hex & 0xFF) / 255)
        }
    }

    /// The hue band the duck owns: nothing derived lands in it.
    public static let duckBand: Range<Double> = 25..<75

    /// A pond's hue in degrees, always the same for the same id (FNV-1a), and never in the duck's band.
    public static func hue(for id: String) -> Double {
        var h: UInt32 = 2_166_136_261
        for b in id.utf8 { h = (h ^ UInt32(b)) &* 16_777_619 }
        return skipDuck(Double(h % 360))
    }

    /// Spreads 0..<360 over the hues outside the duck's band.
    static func skipDuck(_ raw: Double) -> Double {
        let free = 360 - (duckBand.upperBound - duckBand.lowerBound)
        let h = raw.truncatingRemainder(dividingBy: free)
        return h >= duckBand.lowerBound ? h + (duckBand.upperBound - duckBand.lowerBound) : h
    }

    /// Six hues for people's avatars, none a state colour (green working, blue unread, amber waiting, red failed).
    public static let avatarHues: [Double] = [180, 235, 265, 295, 325, 165]

    /// The soft fill: light is a pale wash for `ink` text; dark a deep one for light text.
    public static func rgb(hue: Double, dark: Bool) -> RGB {
        dark ? hsb(hue, 0.40, 0.30) : hsb(hue, 0.28, 0.96)
    }

    public static func rgb(for id: String, dark: Bool) -> RGB { rgb(hue: hue(for: id), dark: dark) }

    /// An avatar's fill: a touch stronger than a pond's tint, so initials sit on a clear disc.
    public static func avatar(index: Int, dark: Bool) -> RGB {
        let hue = avatarHues[((index % avatarHues.count) + avatarHues.count) % avatarHues.count]
        return dark ? hsb(hue, 0.45, 0.42) : hsb(hue, 0.38, 0.90)
    }

    static func hsb(_ hue: Double, _ s: Double, _ v: Double) -> RGB {
        let h = (hue.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let c = v * s, x = c * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1)), m = v - c
        let (r, g, b): (Double, Double, Double)
        switch Int(h) {
        case 0: (r, g, b) = (c, x, 0)
        case 1: (r, g, b) = (x, c, 0)
        case 2: (r, g, b) = (0, c, x)
        case 3: (r, g, b) = (0, x, c)
        case 4: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return RGB(r: r + m, g: g + m, b: b + m)
    }

    /// WCAG 2 relative luminance and contrast ratio.
    public static func luminance(_ c: RGB) -> Double {
        func lin(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }

    public static func contrast(_ a: RGB, _ b: RGB) -> Double {
        let x = luminance(a), y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }
}
