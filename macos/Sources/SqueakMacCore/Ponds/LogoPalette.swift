import Foundation

// A pond's colour from its logo: up to five distinct hues from an icon's pixels, dominant first. Pure: the caller
// hands over RGBA bytes (premultiplied or not, 8 bits, row-major) downsampled to about 32 by 32.

public enum LogoPalette {
    public static let buckets = 24
    public static let minSeparation = 20.0
    public static let maxHues = 5

    /// Hues in degrees (outside the duck's band), strongest first. Empty for a greyscale, blank or tiny image.
    public static func hues(rgba: [UInt8], width: Int, height: Int) -> [Double] {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return [] }
        var weight = [Double](repeating: 0, count: buckets)
        var sumSin = [Double](repeating: 0, count: buckets)
        var sumCos = [Double](repeating: 0, count: buckets)
        for i in 0..<(width * height) {
            let a = Double(rgba[i * 4 + 3]) / 255
            if a < 0.5 { continue }
            let r = Double(rgba[i * 4]) / 255, g = Double(rgba[i * 4 + 1]) / 255, b = Double(rgba[i * 4 + 2]) / 255
            let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
            if mx < 0.18 || mn > 0.92 { continue }          // near black or near white
            let sat = d / mx
            if sat < 0.25 { continue }                        // grey
            var h: Double
            if mx == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) }
            else if mx == g { h = (b - r) / d + 2 }
            else { h = (r - g) / d + 4 }
            h = (h * 60 + 360).truncatingRemainder(dividingBy: 360)
            let k = Int(h / (360 / Double(buckets))) % buckets
            let w = sat * a
            weight[k] += w
            sumSin[k] += w * sin(h * .pi / 180)
            sumCos[k] += w * cos(h * .pi / 180)
        }
        var out: [Double] = []
        for k in weight.indices.sorted(by: { weight[$0] > weight[$1] }) where weight[k] > 0 {
            var h = atan2(sumSin[k], sumCos[k]) * 180 / .pi
            if h < 0 { h += 360 }
            h = PondTint.nudgeOutOfDuckBand(h)
            let apart = out.allSatisfy { o in
                let d = abs(o - h).truncatingRemainder(dividingBy: 360)
                return min(d, 360 - d) >= minSeparation
            }
            if apart { out.append(h) }
            if out.count == maxHues { break }
        }
        return out
    }
}
