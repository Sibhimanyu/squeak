import Foundation

/// The dot-grid loader's frames (marks-v3, loader A), apart from the view so a test can pin them: 9 frames of
/// 110 ms (0.99 s), the quiet variant on a 3 s cycle, frame 5 held under Reduce Motion. One fixed epoch is the
/// shared clock, so every loader on screen is on the same frame.
enum DotGrid {
    static let frames = 9
    static let heldFrame = 4            // frame 5, zero-based
    static let cycle: TimeInterval = 0.99
    static let quietCycle: TimeInterval = 3
    static let epoch = Date(timeIntervalSinceReferenceDate: 0)

    static func frame(at date: Date, quiet: Bool) -> Int {
        let step = (quiet ? quietCycle : cycle) / Double(frames)
        let n = Int((date.timeIntervalSince(epoch) / step).rounded(.down))
        return ((n % frames) + frames) % frames
    }

    /// A dot's strength in a frame: the head 1.0, then 0.6 and 0.35 behind it, the rest 0.2. Dots run down the
    /// columns, left to right (dot = column * 3 + row).
    static func level(dot: Int, frame: Int) -> Double {
        switch ((frame - dot) % frames + frames) % frames {
        case 0: return 1
        case 1: return 0.6
        case 2: return 0.35
        default: return 0.2
        }
    }
}
