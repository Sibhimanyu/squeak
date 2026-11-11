import Foundation

// DESIGN.md §6.5, the thread duck: every thread is a duck in its own colour, picked from the id alone, so the Mac and
// the iPhone agree. FNV-1a over the id's UTF-8 bytes (32-bit), modulo the 11 pond colours. Mirrored in
// ios/SqueakCore `ThreadDuck.swift`; `ThreadDuck.vectors` is asserted on both sides.

public enum ThreadDuck {
    /// The id every surface hashes: a native chat's host session id, a fleet or Conductor chat's session key
    /// (`SessionKey.description`). Never a title.
    public static func index(for id: String) -> Int {
        var h: UInt32 = 2_166_136_261
        for b in id.utf8 { h = (h ^ UInt32(b)) &* 16_777_619 }
        return Int(h % UInt32(PondColours.all.count))
    }

    public static func colour(for id: String) -> (name: String, hue: Double) { PondColours.all[index(for: id)] }

    /// The glyph's tint: the pond palette's hue at full strength, so a small template reads on both grounds.
    public static func rgb(for id: String, dark: Bool) -> PondTint.RGB {
        PondTint.hsb(colour(for: id).hue, dark ? 0.55 : 0.70, dark ? 0.95 : 0.80)
    }

    /// Fixed ids and the colour each must get, on every surface.
    public static let vectors: [(id: String, colour: String)] = [
        ("a", "indigo"), ("session-1", "violet"), ("claude:4f2a9c1e-77b0-4d2a-9d11-0a5c3e9b8f10", "lime"),
        ("native-7c1d", "blue"), ("conductor-chat-42", "violet"),
    ]

    // Sizes (pt) per context: the duck's width; the template is square.
    public enum Size {
        public static let sidebarRow: CGFloat = 18
        public static let pondRow: CGFloat = 22
        public static let tab: CGFloat = 16
        public static let menuRow: CGFloat = 18
        public static let phoneRow: CGFloat = 28
        public static let phoneProjectRow: CGFloat = 24
        public static let phoneRecentRow: CGFloat = 36
    }

    /// The agent badge: half the duck, at its bottom-right corner, offset a tenth outwards.
    public static let badgeFraction: Double = 0.5
    public static let badgeOffsetFraction: Double = 0.12
    /// A duckling (a subagent) is this fraction of its parent's duck.
    public static let ducklingFraction: Double = 0.7

    public static func badgeSize(duck: Double) -> Double { (duck * badgeFraction * 100).rounded() / 100 }
    public static func ducklingSize(parent: Double) -> Double { (parent * ducklingFraction * 100).rounded() / 100 }
}
