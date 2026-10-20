import Foundation

/// How tall the quick message window may be, so the field, the destination row and Send are
/// always on screen however long the context above them is. Heights are in points.
public enum QuickLayout {
    /// The field grows to five lines and then scrolls: 32 + 5 × 20.
    public static let maxFieldHeight: CGFloat = 132
    public static let minFieldHeight: CGFloat = 32

    /// Everything in the window that is not the context's scroll region and not the field: the
    /// window's top and bottom room (28 + 40), the shortcut hints and their gap (24), the pill's
    /// padding (26), the context's status row and its gap (32), the hairline (3), the destination
    /// row (32) and the gaps between the pill's children (30).
    public static let fixedChrome: CGFloat = 215
    /// Kept clear of the screen's edges, menu bar and Dock.
    public static let screenMargin: CGFloat = 36
    /// Never squeezed below a few lines, even on a tiny screen.
    public static let minContext: CGFloat = 80

    /// The most height the context's scroll region may take on a screen `screenHeight` tall
    /// (its usable height) while the field is `fieldHeight` tall.
    public static func contextLimit(screenHeight: CGFloat, fieldHeight: CGFloat) -> CGFloat {
        let field = min(max(fieldHeight, minFieldHeight), maxFieldHeight)
        return max(minContext, screenHeight - fixedChrome - field - screenMargin)
    }

    /// What the scroll region shows: its content's own height (a short reply takes no extra room),
    /// up to the limit, after which it scrolls.
    public static func contextShown(natural: CGFloat, screenHeight: CGFloat, fieldHeight: CGFloat) -> CGFloat {
        max(1, min(natural, contextLimit(screenHeight: screenHeight, fieldHeight: fieldHeight)))
    }

    /// The whole window's height for a context of `natural` height.
    public static func windowHeight(natural: CGFloat, screenHeight: CGFloat, fieldHeight: CGFloat) -> CGFloat {
        let field = min(max(fieldHeight, minFieldHeight), maxFieldHeight)
        return fixedChrome + field + contextShown(natural: natural, screenHeight: screenHeight, fieldHeight: fieldHeight)
    }
}
