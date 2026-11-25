import CoreGraphics

/// Where a suggestion list (the `@` and `/` pickers) opens relative to the composer it belongs to, and how tall it may
/// get. Pure: the views measure the space, this decides. The composer lives at the bottom of the window, so the list opens
/// upward whenever it fits there, and never runs off either edge.
public struct SuggestionPlacement: Equatable, Sendable {
    public enum Direction: Equatable, Sendable { case up, down }

    public var direction: Direction
    /// The tallest the list may be; taller content scrolls.
    public var maxHeight: CGFloat

    /// Gap between the composer's edge and the list.
    public static let gap: CGFloat = 6
    /// Room kept free at the far edge (title bar, window edge).
    public static let edgeMargin: CGFloat = 8

    /// The popover's width: compact, a little wider than a path, never wider than the composer it belongs to.
    public static let preferredWidth: CGFloat = 320
    /// Rows shown before the list scrolls.
    public static let maxRows = 6

    /// The tallest the list gets before it scrolls: `maxRows` rows of `rowHeight` plus the list's own `padding` (top and bottom).
    public static func heightCap(rowHeight: CGFloat, padding: CGFloat) -> CGFloat {
        CGFloat(maxRows) * rowHeight + padding
    }

    public static func width(anchorWidth: CGFloat) -> CGFloat { min(preferredWidth, max(0, anchorWidth)) }

    /// The list's left edge, relative to the composer's left edge: the typed `@` or `/` is where the list starts, so it
    /// reads as coming from that character. Clamped so the list never leaves the composer. A nil trigger (not measurable)
    /// starts at the left edge.
    public static func originX(triggerX: CGFloat?, anchorWidth: CGFloat, popupWidth: CGFloat) -> CGFloat {
        let room = max(0, anchorWidth - popupWidth)
        guard let triggerX else { return 0 }
        return min(max(0, triggerX), room)
    }

    /// The list's top edge, relative to the composer's top edge: above it with `gap` clear of the top border (so the field and
    /// its text stay visible), or below it with `gap` clear of the bottom border.
    public static func originY(direction: Direction, anchorHeight: CGFloat, popupHeight: CGFloat) -> CGFloat {
        switch direction {
        case .up: -(popupHeight + gap)
        case .down: anchorHeight + gap
        }
    }

    public static func origin(direction: Direction, triggerX: CGFloat?, anchorSize: CGSize, popupSize: CGSize) -> CGPoint {
        CGPoint(
            x: originX(triggerX: triggerX, anchorWidth: anchorSize.width, popupWidth: popupSize.width),
            y: originY(direction: direction, anchorHeight: anchorSize.height, popupHeight: popupSize.height))
    }

    public static func resolve(spaceAbove: CGFloat, spaceBelow: CGFloat, contentHeight: CGFloat, cap: CGFloat = .infinity) -> SuggestionPlacement {
        let up = max(0, spaceAbove - gap - edgeMargin)
        let down = max(0, spaceBelow - gap - edgeMargin)
        let content = min(max(0, contentHeight), cap)
        // Up first: it is where the composer's own surroundings are. Down only when up cannot hold it and down can.
        if content <= up || up >= down { return SuggestionPlacement(direction: .up, maxHeight: min(content, up)) }
        return SuggestionPlacement(direction: .down, maxHeight: min(content, down))
    }

    /// Rows in the order they are drawn, top to bottom, as indices into the ranked list. Above the composer the best match
    /// sits nearest it (the last drawn row); below, it is first.
    public static func drawOrder(count: Int, direction: Direction) -> [Int] {
        let order = Array(0..<max(count, 0))
        return direction == .up ? order.reversed() : order
    }

    /// The ranked-index step for an arrow key: Up always moves up the screen, Down down. With the list above the composer
    /// the ranked list runs bottom to top, so Up goes to the next worse match.
    public static func step(up: Bool, direction: Direction) -> Int {
        switch direction {
        case .up: up ? 1 : -1
        case .down: up ? -1 : 1
        }
    }
}
