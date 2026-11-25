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

    public static func resolve(spaceAbove: CGFloat, spaceBelow: CGFloat, contentHeight: CGFloat) -> SuggestionPlacement {
        let up = max(0, spaceAbove - gap - edgeMargin)
        let down = max(0, spaceBelow - gap - edgeMargin)
        let content = max(0, contentHeight)
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
