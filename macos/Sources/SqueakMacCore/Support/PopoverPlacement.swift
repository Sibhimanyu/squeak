import CoreGraphics

/// Where the menu-bar panel sits: centred under its status item, top edge just below the menu bar,
/// kept inside the screen's usable area. Pure, so the clamping is tested without a screen.
public enum PopoverPlacement {
    /// Gap between the menu bar and the panel's top edge.
    public static let gap: CGFloat = 6
    /// Smallest distance to the screen's left, right and bottom edges.
    public static let edgeMargin: CGFloat = 8

    /// Frames are in AppKit screen coordinates (origin bottom-left). `button` is the status item
    /// button's frame on screen, `visible` the screen's `visibleFrame` (menu bar and Dock excluded).
    public static func frame(button: CGRect, size: CGSize, visible: CGRect) -> CGRect {
        let width = min(size.width, max(0, visible.width - 2 * edgeMargin))
        let top = min(button.minY, visible.maxY) - gap
        let height = min(size.height, max(0, top - visible.minY - edgeMargin))
        var x = button.midX - width / 2
        x = min(x, visible.maxX - edgeMargin - width)
        x = max(x, visible.minX + edgeMargin)
        return CGRect(x: x, y: top - height, width: width, height: height)
    }
}
