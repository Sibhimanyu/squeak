import Foundation

/// One stable rhythm per chat. Text and pixels share a phase, while neighboring chats have
/// different patterns, offsets and speeds. No frame-by-frame random flicker or shared global beat.
public struct MatrixMotion: Sendable {
    public let seed: Double
    private let offset: Double
    private let period: Double

    public init(identity: String) {
        var hash: UInt64 = 14695981039346656037
        for byte in identity.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        seed = Double(hash & 0xFFFF) / 65535
        offset = Double((hash >> 16) & 0xFFFF) / 65535 * 120
        period = 4.2 + Double((hash >> 32) & 0xFFFF) / 65535 * 1.8
    }

    public func phase(at time: TimeInterval, still: Bool = false) -> Double {
        guard !still else { return 0.48 }
        let value = (time + offset) / period
        return value - floor(value)
    }

    public func patternTime(at time: TimeInterval, still: Bool = false) -> Double {
        (still ? 2.4 : time) * (0.8 + seed * 0.45) + offset
    }

    /// The light reaches the trailing matrix after it has crossed the preview's letters.
    public func arrival(at time: TimeInterval, still: Bool = false) -> Double {
        let distance = (phase(at: time, still: still) - 0.80) / 0.13
        return exp(-distance * distance)
    }
}
