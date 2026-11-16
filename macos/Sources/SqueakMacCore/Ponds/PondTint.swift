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
    /// A named colour's hue, or the hue in `hue:<0-359>` (a colour taken from the pond's logo, nudged out of the
    /// duck's band). Anything else is nil, and the pond keeps the hue from its id.
    public static func hue(named name: String?) -> Double? {
        guard let name else { return nil }
        if let h = all.first(where: { $0.name == name })?.hue { return h }
        guard name.hasPrefix("hue:"), let n = Int(name.dropFirst(4)), (0..<360).contains(n) else { return nil }
        return PondTint.nudgeOutOfDuckBand(Double(n))
    }

    /// The stored value for a hue taken from the logo (older Macs wrote this; still read).
    public static func value(hue: Double) -> String { "hue:\(Int(PondTint.nudgeOutOfDuckBand(hue).rounded()) % 360)" }
    /// The stored value for a real colour taken from the logo: `#rrggbb`.
    public static func value(colour: PondTint.RGB) -> String { colour.hexString }
    public static func isLogoValue(_ v: String?) -> Bool { v?.hasPrefix("hue:") == true || v?.hasPrefix("#") == true }

    /// What a stored colour means: a named colour or old `hue:` value is a hue; `#rrggbb` is the real colour itself.
    public static func seed(named name: String?) -> PondSeed? {
        if let name, name.hasPrefix("#") { return PondTint.RGB(hexString: name).map(PondSeed.colour) }
        return hue(named: name).map(PondSeed.hue)
    }
}

/// The colour a pond's look starts from: a hue (a named or old stored colour, rendered in the fixed soft palette) or a
/// real colour from the logo (kept as it is; only lightness moves, and only as far as legibility needs).
public enum PondSeed: Equatable, Sendable {
    case hue(Double)
    case colour(PondTint.RGB)
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

    /// A hue inside the duck's band moves to the nearest edge of it.
    public static func nudgeOutOfDuckBand(_ hue: Double) -> Double {
        let h = (hue.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        guard duckBand.contains(h) else { return h }
        return h - duckBand.lowerBound < duckBand.upperBound - h ? duckBand.lowerBound - 1 : duckBand.upperBound
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

    /// The soft fill for a seed. A real colour keeps its exact hue and its saturation's proportion (a third of it on the
    /// pale light fill, about half on the deep dark one), so a deep green tints a green and never a grey-green or another hue.
    public static func rgb(seed: PondSeed, dark: Bool) -> RGB {
        switch seed {
        case .hue(let h): return rgb(hue: h, dark: dark)
        case .colour(let c):
            let (h, s, _) = hsv(c)
            return dark ? hsb(h, min(1, s * 0.6), 0.30) : hsb(h, min(1, s * 0.35), 0.96)
        }
    }

    public static func rgb(for id: String, dark: Bool) -> RGB { rgb(hue: hue(for: id), dark: dark) }

    /// An avatar's fill: a touch stronger than a pond's tint, so initials sit on a clear disc.
    public static func avatar(index: Int, dark: Bool) -> RGB {
        let hue = avatarHues[((index % avatarHues.count) + avatarHues.count) % avatarHues.count]
        return dark ? hsb(hue, 0.45, 0.42) : hsb(hue, 0.38, 0.90)
    }

    /// Hue (degrees), saturation and value of a colour.
    public static func hsv(_ c: RGB) -> (h: Double, s: Double, v: Double) {
        let mx = max(c.r, c.g, c.b), mn = min(c.r, c.g, c.b), d = mx - mn
        guard d > 0 else { return (0, 0, mx) }
        var h: Double
        if mx == c.r { h = ((c.g - c.b) / d).truncatingRemainder(dividingBy: 6) }
        else if mx == c.g { h = (c.b - c.r) / d + 2 }
        else { h = (c.r - c.g) / d + 4 }
        h = (h * 60 + 360).truncatingRemainder(dividingBy: 360)
        return (h, d / mx, mx)
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
