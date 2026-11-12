import Foundation

/// Full screen has no title bar: the window controls ("lights") slide into the sidebar's top row when the pointer reaches
/// the top of the screen, pushing the Back/Forward arrows right, and slide out again when it leaves. This is the pure
/// part: when they are revealed (a state machine over the pointer, with an injected clock) and how far the row shifts.
public struct FullScreenReveal: Sendable, Equatable {
    /// Distance from the screen's top edge that reveals the controls.
    public static let triggerBand: Double = 4
    /// How long the pointer may be away from the top region and the controls before they slide out.
    public static let hideDelay: TimeInterval = 0.6

    public private(set) var revealed = false
    private var lastInside: Date?

    public init() {}

    /// One look at the pointer. `fromTop` is the pointer's distance below the top of the screen (negative or 0 at the edge),
    /// `menuBarHeight` the height of the menu bar that slides in with it, `overControls` whether it is on the controls.
    /// Returns whether the controls are now revealed. Reaching the top band reveals; the menu bar's height and the
    /// controls themselves keep them revealed; leaving all of that hides them after `hideDelay`.
    @discardableResult
    public mutating func update(now: Date, fromTop: Double, menuBarHeight: Double, overControls: Bool) -> Bool {
        let entering = fromTop <= Self.triggerBand
        let staying = revealed && (fromTop <= menuBarHeight || overControls)
        if entering || staying {
            revealed = true
            lastInside = now
        } else if revealed, let last = lastInside, now.timeIntervalSince(last) >= Self.hideDelay {
            revealed = false
            lastInside = nil
        }
        return revealed
    }

    /// Leaves full screen, or the window stops being the one in front: nothing stays revealed.
    public mutating func reset() { revealed = false; lastInside = nil }
}

public enum FullScreenLights {
    /// macOS's own metrics: 12pt circles, 8pt apart.
    public static let diameter: Double = 12
    public static let gap: Double = 8
    public static let width: Double = diameter * 3 + gap * 2
    /// The gap between the controls and the first thing after them.
    public static let trailingGap: Double = 4

    /// The room the row gives the window controls at its left. Windowed: the system traffic lights' 70pt, always.
    /// Full screen: nothing at rest, the controls' width plus a gap while they are revealed.
    public static func clearance(fullScreen: Bool, revealed: Bool) -> Double {
        guard fullScreen else { return PaneToggle.trafficLights }
        return revealed ? width + trailingGap : 0
    }
}
