import Foundation

/// How far this phone's clock runs ahead of the Mac's (negative: behind). The chat compares times the phone
/// stamped (when a message was sent) with times the Mac stamped (history, steps), so a phone that is 20 seconds
/// off put a steer on the wrong side of every step. The Mac stamps every result it writes (`at`, epoch ms); the
/// moment the phone reads it, phone time minus that stamp is the skew plus the time the result took to arrive.
/// The smallest recent reading is the closest to the skew itself, so it is the one used.
public struct ClockSkew: Equatable, Sendable {
    struct Sample: Equatable, Sendable {
        let seen: Date
        let value: TimeInterval
    }

    /// Readings older than this are dropped: a clock that was set since must not be believed.
    public static let keep: TimeInterval = 30 * 60
    static let most = 8

    private var samples: [Sample] = []

    public init() {}

    /// Phone time minus Mac time; zero until the Mac has stamped something.
    public var offset: TimeInterval { samples.map(\.value).min() ?? 0 }

    /// A result the Mac stamped `macAt`, read by the phone at `receivedAt`. Only a result read as it arrived says
    /// anything about the clocks: one read long after it was written (a leftover) measures its age, not the skew.
    public mutating func observe(macAt: Date, receivedAt: Date) {
        samples.removeAll { receivedAt.timeIntervalSince($0.seen) > Self.keep || $0.seen > receivedAt }
        samples.append(Sample(seen: receivedAt, value: receivedAt.timeIntervalSince(macAt)))
        if samples.count > Self.most { samples.removeFirst(samples.count - Self.most) }
    }

    /// `at` as the Mac wrote it: epoch milliseconds.
    public mutating func observe(macMillis: Int64, receivedAt: Date) {
        observe(macAt: Date(timeIntervalSince1970: Double(macMillis) / 1000), receivedAt: receivedAt)
    }
}
