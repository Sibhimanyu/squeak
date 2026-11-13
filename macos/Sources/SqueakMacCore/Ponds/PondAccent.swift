import Foundation

// A pond's accent drawn next to its icon (the overview card's top bar, the selected pond's mark) comes from the logo's
// most vivid colour, not from its most common one: a dark-green icon with a lime dot reads lime/green, never the dull
// grey-green a pale tint of the average gives. Pure: the caller hands over the same 32 by 32 RGBA bytes as `LogoPalette`.

public enum PondAccent {
    /// Contrast an accent must keep against the card it sits on (WCAG 2 non-text, 3:1; DESIGN.md §3.4).
    public static let minContrast = 3.0
    /// The card surfaces (`Tokens`: surface in light and dark) the accent is measured against.
    public static let lightSurface = PondTint.RGB(hex: 0xFAFAF9)
    public static let darkSurface = PondTint.RGB(hex: 0x211E1C)

    /// The hue (degrees, never in the duck's band) of the logo's most vivid colour; nil for a greyscale or blank icon.
    /// Each pixel counts by area, saturation and the cube of its brightness, so a small bright accent outweighs a large
    /// dark field of the same hue family.
    public static func vividHue(rgba: [UInt8], width: Int, height: Int) -> Double? {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return nil }
        let buckets = LogoPalette.buckets
        var weight = [Double](repeating: 0, count: buckets)
        var sumSin = [Double](repeating: 0, count: buckets)
        var sumCos = [Double](repeating: 0, count: buckets)
        for i in 0..<(width * height) {
            let a = Double(rgba[i * 4 + 3]) / 255
            if a < 0.5 { continue }
            let r = Double(rgba[i * 4]) / 255, g = Double(rgba[i * 4 + 1]) / 255, b = Double(rgba[i * 4 + 2]) / 255
            let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
            if mx < 0.18 || mn > 0.92 { continue }
            let sat = d / mx
            if sat < 0.25 { continue }
            var h: Double
            if mx == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) }
            else if mx == g { h = (b - r) / d + 2 }
            else { h = (r - g) / d + 4 }
            h = (h * 60 + 360).truncatingRemainder(dividingBy: 360)
            let k = Int(h / (360 / Double(buckets))) % buckets
            let w = a * sat * mx * mx * mx
            weight[k] += w
            sumSin[k] += w * sin(h * .pi / 180)
            sumCos[k] += w * cos(h * .pi / 180)
        }
        guard let best = weight.indices.max(by: { weight[$0] < weight[$1] }), weight[best] > 0 else { return nil }
        var h = atan2(sumSin[best], sumCos[best]) * 180 / .pi
        if h < 0 { h += 360 }
        return PondTint.nudgeOutOfDuckBand(h)
    }

    /// The accent for a hue: vivid (saturation 0.75), its brightness moved only as far as the 3:1 contrast needs, so lime
    /// darkens to a readable green on light and stays bright on dark. A hue that cannot reach 3:1 at full brightness
    /// (blue on the dark card) gives up saturation last.
    public static func rgb(hue: Double, dark: Bool) -> PondTint.RGB {
        let surface = dark ? darkSurface : lightSurface
        var best = PondTint.hsb(hue, 0.75, dark ? 1.0 : 0.2)
        for sat in stride(from: 0.75, through: 0.30, by: -0.05) {
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
