import Foundation

/// DESIGN.md §7: the motion tokens as plain numbers, so the values and the Reduce Motion mapping are testable
/// without SwiftUI. The app's `Motion` (SqueakMac/Motion.swift) turns these into animations; nothing else in the
/// app writes a raw duration, spring or easing.
public enum MotionToken: CaseIterable, Sendable {
    /// Hover, press release, small toggles.
    case quick
    /// Panels, sidebar, tab insert/remove, popovers, list insert/remove.
    case standard
    /// Sheets and onboarding only.
    case emphasis
    /// Streaming text, timers, scroll-follow, anything driven per frame.
    case none

    public var duration: Double {
        switch self {
        case .quick: 0.12
        case .standard: 0.20
        case .emphasis: 0.32
        case .none: 0
        }
    }

    /// What a token becomes under Reduce Motion: no travel, a crossfade no slower than `quick`.
    public func resolved(reduceMotion: Bool) -> Resolved {
        guard reduceMotion else { return Resolved(duration: duration, allowsMovement: self != .none) }
        return Resolved(duration: min(duration, MotionToken.quick.duration), allowsMovement: false)
    }

    public struct Resolved: Equatable, Sendable {
        public let duration: Double
        public let allowsMovement: Bool
    }
}

public enum MotionRules {
    /// A message arriving while the person follows the chat rises at most this far (points).
    public static let maxRise = 6.0
    /// Press-down has no animation: the pressed state is shown on the same frame.
    public static let pressDownAnimated = false
}
