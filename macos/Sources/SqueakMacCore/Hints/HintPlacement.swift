import CoreGraphics

/// Where a hover hint goes: below its control with a gap, above when there is no room below, clamped inside the
/// window, never over the control. Coordinates are top-left origin, y down.
public enum HintPlacement {
    public static let gap: CGFloat = 6
    public static let edgeInset: CGFloat = 4

    public static func origin(control: CGRect, hint: CGSize, window: CGRect, gap: CGFloat = gap) -> CGPoint {
        let belowY = control.maxY + gap
        let aboveY = control.minY - gap - hint.height
        let fitsBelow = belowY + hint.height <= window.maxY - edgeInset
        let fitsAbove = aboveY >= window.minY + edgeInset
        // Below by default; above when below does not fit. If neither fits, take the side with more room.
        let y: CGFloat
        if fitsBelow { y = belowY }
        else if fitsAbove { y = aboveY }
        else { y = (window.maxY - control.maxY) >= (control.minY - window.minY) ? belowY : aboveY }
        let lo = window.minX + edgeInset
        let hi = max(lo, window.maxX - edgeInset - hint.width)
        let x = min(max(control.midX - hint.width / 2, lo), hi)
        return CGPoint(x: x, y: y)
    }
}
