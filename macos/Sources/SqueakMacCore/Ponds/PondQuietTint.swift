import Foundation

// Spec, Workspace, "Top area as one surface": a Pond's colour is an accent, never a fill. The tint that sits behind the top bar
// and the Duck subheader is derived from the Pond's colour and then made quiet in OKLCH: chroma capped, lightness held close to the
// ground it lies on, a low maximum opacity, and a short fade. So a bright logo (yellow, neon green) and a deep one (navy) all end
// up as a faint warm or cool breath on the ground, never a loud band. Pure, so the caps are tested.

public enum PondQuietTint {
    /// Chroma never exceeds this (OKLCH C; a vivid logo colour is 0.15 to 0.30).
    public static let maxChroma = 0.05
    /// How far the tint's lightness may sit from the ground's (OKLab L; dark grounds go a touch lighter, light ones a touch darker).
    public static let lightnessOffset = 0.05
    /// The strongest the tint gets, at the top edge, per appearance.
    public static func maxOpacity(dark: Bool) -> Double { dark ? 0.55 : 0.5 }
    /// The tint fades to nothing within this many points.
    public static let fadeHeight = 120.0
    /// The most the blended top of the tint may differ from its ground (OKLab distance): "quiet" as a number.
    public static let maxPeakDistance = 0.045

    /// The quiet tint colour for a Pond seed, lying on `ground`: the seed's hue, chroma capped, lightness near the ground's.
    public static func rgb(seed: PondSeed, dark: Bool, ground: PondTint.RGB) -> PondTint.RGB {
        quiet(PondAccent.rgb(seed: seed, dark: dark), dark: dark, ground: ground)
    }

    /// Any colour made quiet on a ground.
    public static func quiet(_ source: PondTint.RGB, dark: Bool, ground: PondTint.RGB) -> PondTint.RGB {
        let s = Lch(source), g = Lch(ground)
        let l = min(max(g.l + (dark ? lightnessOffset : -lightnessOffset), 0), 1)
        return Lch(l: l, c: min(s.c, maxChroma), h: s.h).rgbInGamut
    }

    /// The window ground the top surface lies on.
    public static func ground(dark: Bool) -> PondTint.RGB { PondTint.RGB(hex: dark ? Tokens.Dark.bg : Tokens.Light.bg) }

    /// The tint behind the top area for a seed: its colour and the opacity at the very top.
    public static func top(seed: PondSeed, dark: Bool) -> (rgb: PondTint.RGB, opacity: Double) {
        (rgb(seed: seed, dark: dark, ground: ground(dark: dark)), maxOpacity(dark: dark))
    }

    /// What the top edge looks like once blended over the ground.
    public static func peak(seed: PondSeed, dark: Bool) -> PondTint.RGB {
        let t = top(seed: seed, dark: dark)
        return PondWash.blend(t.rgb, over: ground(dark: dark), opacity: t.opacity)
    }

    // MARK: OKLab / OKLCH (Bjorn Ottosson's matrices)

    public struct Lch: Equatable, Sendable {
        public var l: Double, c: Double, h: Double
        public init(l: Double, c: Double, h: Double) { self.l = l; self.c = c; self.h = h }

        public init(_ rgb: PondTint.RGB) {
            let (l, a, b) = PondQuietTint.oklab(rgb)
            self.init(l: l, c: (a * a + b * b).squareRoot(), h: atan2(b, a))
        }

        /// The colour at this L, C and hue, with chroma reduced until it fits sRGB.
        public var rgbInGamut: PondTint.RGB {
            var chroma = c
            while true {
                let (r, g, b) = PondQuietTint.linear(l: l, a: chroma * cos(h), b: chroma * sin(h))
                let eps = 1e-6
                if chroma <= 0 || ((-eps...(1 + eps)).contains(r) && (-eps...(1 + eps)).contains(g) && (-eps...(1 + eps)).contains(b)) {
                    func enc(_ v: Double) -> Double {
                        let x = min(max(v, 0), 1)
                        return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
                    }
                    return PondTint.RGB(r: enc(r), g: enc(g), b: enc(b))
                }
                chroma = max(chroma - 0.002, 0)
            }
        }
    }

    static func oklab(_ c: PondTint.RGB) -> (Double, Double, Double) {
        func dec(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let r = dec(c.r), g = dec(c.g), b = dec(c.b)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
    }

    static func linear(l: Double, a: Double, b: Double) -> (Double, Double, Double) {
        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b
        let l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_
        return (4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
                -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
                -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3)
    }

    /// Distance between two colours in OKLab.
    public static func distance(_ a: PondTint.RGB, _ b: PondTint.RGB) -> Double {
        let p = oklab(a), q = oklab(b)
        let dl = p.0 - q.0, da = p.1 - q.1, db = p.2 - q.2
        return (dl * dl + da * da + db * db).squareRoot()
    }
}
