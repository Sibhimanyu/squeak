import Foundation

// A pond's accent drawn next to its icon (the overview card's top bar, the selected pond's mark) starts from the
// logo's real accent colour (`LogoColours`: the most vivid, not the most common), never a hue re-rendered at a fixed
// saturation. Only its value (lightness) moves, and only as far as 3:1 contrast needs (DESIGN.md §3.5).

public enum PondAccent {
    /// Contrast an accent must keep against the card it sits on (WCAG 2 non-text, 3:1; DESIGN.md §3.4).
    public static let minContrast = 3.0
    /// The card surfaces (`Tokens`: surface in light and dark) the accent is measured against.
    public static let lightSurface = PondTint.RGB(hex: 0xFAFAF9)
    public static let darkSurface = PondTint.RGB(hex: 0x211E1C)

    /// The accent for a seed. A real logo colour keeps its hue and saturation: only its value moves, as little as the 3:1
    /// contrast needs (lime darkens to a readable lime-green on light, a deep green lightens on dark). Only a colour that
    /// cannot reach 3:1 by value alone (a saturated blue on the dark card) gives up saturation, in the smallest steps.
    public static func rgb(seed: PondSeed, dark: Bool) -> PondTint.RGB {
        switch seed {
        case .hue(let h): return rgb(hue: h, dark: dark)
        case .colour(let c):
            let surface = dark ? darkSurface : lightSurface
            if PondTint.contrast(c, surface) >= minContrast { return c }
            let (h, s0, v0) = PondTint.hsv(c)
            var best = c
            var s = s0
            while s >= 0 {
                var v = v0
                let step = dark ? 0.01 : -0.01
                while v >= 0, v <= 1 {
                    let t = PondTint.hsb(h, s, v)
                    best = t
                    if PondTint.contrast(t, surface) >= minContrast { return t }
                    v += step
                }
                s -= 0.05
            }
            return best
        }
    }

    /// The accent for a hue: vivid (saturation 0.85, so lime stays lime), its brightness moved only as far as the 3:1 contrast needs, so lime
    /// darkens to a readable green on light and stays bright on dark. A hue that cannot reach 3:1 at full brightness
    /// (blue on the dark card) gives up saturation last.
    public static func rgb(hue: Double, dark: Bool) -> PondTint.RGB {
        let surface = dark ? darkSurface : lightSurface
        var best = PondTint.hsb(hue, 0.85, dark ? 1.0 : 0.2)
        for sat in stride(from: 0.85, through: 0.30, by: -0.05) {
            var v = dark ? 0.78 : 0.85
            while v <= 1.0, v >= 0.2 {
                let c = PondTint.hsb(hue, sat, v)
                if PondTint.contrast(c, surface) >= minContrast { return c }
                v += dark ? 0.02 : -0.02
            }
            best = PondTint.hsb(hue, sat, dark ? 1.0 : 0.2)
        }
        return best
    }
}
