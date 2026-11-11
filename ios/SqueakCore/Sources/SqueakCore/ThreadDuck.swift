import Foundation

// DESIGN.md §6.5, the thread duck: a thread's duck colour comes from its id alone, so the iPhone and the Mac agree.
// A mirror of macos/Sources/SqueakMacCore/Model/ThreadDuck.swift: FNV-1a over the id's UTF-8 bytes (32-bit), modulo
// the 11 pond colours. `vectors` is the shared list both test suites assert.

public enum ThreadDuck {
    /// The pond palette (the host's `POND_COLOURS`): a name and a hue in degrees.
    public static let palette: [(name: String, hue: Double)] = [
        ("red", 355), ("coral", 10), ("lime", 95), ("green", 140), ("teal", 175), ("cyan", 195),
        ("blue", 220), ("indigo", 245), ("violet", 270), ("purple", 295), ("pink", 325),
    ]

    /// The id every surface hashes: the thread's session key (`PhoneSnapshot.Session.key`). Never a title.
    public static func index(for id: String) -> Int {
        var h: UInt32 = 2_166_136_261
        for b in id.utf8 { h = (h ^ UInt32(b)) &* 16_777_619 }
        return Int(h % UInt32(palette.count))
    }

    public static func colour(for id: String) -> (name: String, hue: Double) { palette[index(for: id)] }

    /// The glyph's tint as HSB (hue in degrees): the same strength as the Mac's.
    public static func hsb(for id: String, dark: Bool) -> (h: Double, s: Double, b: Double) {
        (colour(for: id).hue, dark ? 0.55 : 0.70, dark ? 0.95 : 0.80)
    }

    /// The duck's width (pt) in a phone's thread row; a duckling is `ducklingFraction` of it.
    public static let phoneRowSize = 28.0

    public static let vectors: [(id: String, colour: String)] = [
        ("a", "indigo"), ("session-1", "violet"), ("claude:4f2a9c1e-77b0-4d2a-9d11-0a5c3e9b8f10", "lime"),
        ("native-7c1d", "blue"), ("conductor-chat-42", "violet"),
    ]

    /// Half the duck, at its bottom-right corner, offset a tenth outwards; a duckling is 0.7 of its parent.
    public static let badgeFraction = 0.5
    public static let badgeOffsetFraction = 0.12
    public static let ducklingFraction = 0.7
    public static func badgeSize(duck: Double) -> Double { (duck * badgeFraction * 100).rounded() / 100 }
    public static func ducklingSize(parent: Double) -> Double { (parent * ducklingFraction * 100).rounded() / 100 }
}
