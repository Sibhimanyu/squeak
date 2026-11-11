import Foundation

/// AppKit screen coordinates (Y increases upwards). A dropdown stays next to its trigger;
/// only screen edges may move it, and a short space below opens it above the same control.
public enum MenuPlacement {
    public static let gap: CGFloat = 2
    public static let screenMargin: CGFloat = 6

    public static func frame(anchor: CGRect, menu: CGSize, visibleFrame: CGRect,
                             submenu: Bool = false, contextPoint: CGPoint? = nil) -> CGRect {
        let safe = visibleFrame.insetBy(dx: screenMargin, dy: screenMargin)
        var x = submenu ? anchor.maxX + gap : anchor.minX
        var top = submenu ? anchor.maxY : anchor.minY - gap
        if let point = contextPoint {
            x = anchor.minX + point.x * anchor.width
            top = anchor.maxY - point.y * anchor.height
        } else if !submenu, top - menu.height < safe.minY,
                  safe.maxY - anchor.maxY > anchor.minY - safe.minY {
            top = anchor.maxY + gap + menu.height
        }
        if x + menu.width > safe.maxX {
            x = submenu ? anchor.minX - gap - menu.width : anchor.maxX - menu.width
        }
        x = max(safe.minX, min(x, safe.maxX - menu.width))
        let y = max(safe.minY, min(top - menu.height, safe.maxY - menu.height))
        return CGRect(origin: CGPoint(x: x, y: y), size: menu)
    }
}
