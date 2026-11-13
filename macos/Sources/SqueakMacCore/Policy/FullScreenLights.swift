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

    /// One look at the pointer, all in distances below the top of the screen (`fromTop`: negative or 0 at the edge).
    /// `menuBarHeight` is the height of the menu bar that slides in with it. `rowBottom` is the MEASURED bottom of the
    /// sidebar's top row (the row the controls sit in) in the same terms: when macOS slides its menu bar and titlebar
    /// down, the window's content is pushed down with it, so the row's real position is not a fixed distance from the
    /// screen's top and has to be read, not assumed. `overControls` is whether the pointer is on the controls' measured
    /// rectangle, already padded. Reaching the top band reveals; the menu bar, everything down to the row's bottom (the
    /// full width: macOS hides its menu bar the moment the pointer leaves it) and the controls keep them revealed;
    /// leaving all of that hides them after `hideDelay`.
    @discardableResult
    public mutating func update(now: Date, fromTop: Double, menuBarHeight: Double, rowBottom: Double = 0, overControls: Bool) -> Bool {
        let entering = fromTop <= Self.triggerBand
        let staying = revealed && (fromTop <= max(menuBarHeight, rowBottom) || overControls)
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
    /// macOS's own metrics: 12pt circles, 8pt apart (a 20pt pitch).
    public static let diameter: Double = 12
    public static let gap: Double = 8
    public static let width: Double = diameter * 3 + gap * 2
    /// Where the close button's left edge sits in a window's titlebar (a full-size-content window: x = 20, the standard
    /// traffic-light position). The controls use it in full screen so they land where a window draws them.
    public static let leadingInset: Double = 20

    /// The room the row gives the window controls at its left. Windowed: the system traffic lights' 70pt, always.
    /// Full screen: nothing at rest; while revealed exactly the windowed 70pt, so the arrows (and a closed sidebar's
    /// toggle) land pixel for pixel where they do in a window.
    public static func clearance(fullScreen: Bool, revealed: Bool) -> Double {
        guard fullScreen else { return PaneToggle.trafficLights }
        return revealed ? PaneToggle.trafficLights : 0
    }

    /// The x of control `index` (0 close, 1 minimise, 2 zoom) from the window's left edge; never negative.
    public static func lightX(_ index: Int) -> Double { max(0, leadingInset) + Double(index) * (diameter + gap) }

    /// The right edge of the last control.
    public static var trailingEdge: Double { lightX(2) + diameter }

    /// The group's x while revealed, and where it waits (clear of the screen) while hidden.
    public static func groupX(revealed: Bool) -> Double { revealed ? lightX(0) : -(trailingEdge + 1) }

    /// How far around the measured controls the pointer still counts as on them.
    public static let hitPadding: Double = 16

    /// Whether a pointer at (`x`, `fromTop`) is on the controls' rectangle (`minX`...`maxX`, `minFromTop`...`maxFromTop`,
    /// all measured live in screen terms) padded by `padding` on every side.
    public static func isOver(x: Double, fromTop: Double, minX: Double, maxX: Double, minFromTop: Double, maxFromTop: Double,
                              padding: Double = hitPadding) -> Bool {
        x >= minX - padding && x <= maxX + padding && fromTop >= minFromTop - padding && fromTop <= maxFromTop + padding
    }

    /// The group's y in a row of `rowHeight`: centred on the row's centre line, as the arrows are.
    public static func lightY(rowHeight: Double) -> Double { (rowHeight - diameter) / 2 }
}
