import Foundation
#if os(iOS)
import SwiftUI
import UIKit
#endif

/// A pond's generated mark, the same one the Mac sidebar draws for a pond with no icon of its own: the project's first
/// letter, bold, on the pond's soft tint. The tint is the pond's chosen colour (a name, or `hue:<0-359>`), else a hue
/// from its id (FNV-1a, never in the duck's yellow band). Ported from the Mac's `PondTint` (macos/Sources/SqueakMacCore/
/// Ponds/PondTint.swift); `PondMarkTests` pins the numbers.
enum PondMarkTint {
    static let named: [(name: String, hue: Double)] = [
        ("red", 355), ("coral", 10), ("lime", 95), ("green", 140), ("teal", 175), ("cyan", 195),
        ("blue", 220), ("indigo", 245), ("violet", 270), ("purple", 295), ("pink", 325),
    ]
    static let duckBand: Range<Double> = 25..<75

    static func hue(named name: String?) -> Double? {
        guard let name else { return nil }
        if let h = named.first(where: { $0.name == name })?.hue { return h }
        guard name.hasPrefix("hue:"), let n = Int(name.dropFirst(4)), (0..<360).contains(n) else { return nil }
        return nudgeOutOfDuckBand(Double(n))
    }

    static func hue(for id: String) -> Double {
        var h: UInt32 = 2_166_136_261
        for b in id.utf8 { h = (h ^ UInt32(b)) &* 16_777_619 }
        return skipDuck(Double(h % 360))
    }

    static func nudgeOutOfDuckBand(_ hue: Double) -> Double {
        let h = (hue.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        guard duckBand.contains(h) else { return h }
        return h - duckBand.lowerBound < duckBand.upperBound - h ? duckBand.lowerBound - 1 : duckBand.upperBound
    }

    static func skipDuck(_ raw: Double) -> Double {
        let free = 360 - (duckBand.upperBound - duckBand.lowerBound)
        let h = raw.truncatingRemainder(dividingBy: free)
        return h >= duckBand.lowerBound ? h + (duckBand.upperBound - duckBand.lowerBound) : h
    }

    /// The pond's hue: its chosen colour, else the one from its id.
    static func hue(colour: String?, id: String) -> Double { hue(named: colour) ?? hue(for: id) }

    /// The soft fill: light is a pale wash for ink text, dark a deep one for light text.
    static func rgb(hue: Double, dark: Bool) -> (r: Double, g: Double, b: Double) {
        dark ? hsb(hue, 0.40, 0.30) : hsb(hue, 0.28, 0.96)
    }

    static func hsb(_ hue: Double, _ s: Double, _ v: Double) -> (r: Double, g: Double, b: Double) {
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
        return (r + m, g + m, b + m)
    }

    /// The letter the mark shows: the name's first character, upper-cased.
    static func letter(_ name: String) -> String { String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased() }
}

#if os(iOS)
/// A pond's icon: the icon the Mac sent for it, else its generated letter mark (what the Mac sidebar draws).
struct PondMark: View {
    @Environment(AppModel.self) private var model
    let item: PondItem
    var size: CGFloat = 44

    var body: some View {
        if let icon = model.pondIconName(item) {
            ProjectMark(name: icon, size: size, folder: true, round: true)
        } else {
            let hue = PondMarkTint.hue(colour: item.meta.colour, id: item.id)
            let fill = Color(UIColor { traits in
                let c = PondMarkTint.rgb(hue: hue, dark: traits.userInterfaceStyle == .dark)
                return UIColor(red: c.r, green: c.g, blue: c.b, alpha: 1)
            })
            Text(PondMarkTint.letter(item.name))
                .font(.system(size: size * 0.42, weight: .bold)).foregroundStyle(Theme.ink)
                .frame(width: size, height: size)
                .background(fill, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
                .accessibilityHidden(true)
        }
    }
}
#endif
