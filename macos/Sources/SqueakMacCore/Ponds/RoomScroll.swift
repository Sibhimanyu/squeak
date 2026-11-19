import Foundation

/// The room's scroll arithmetic (pure, so the app and its tests agree): a room follows its end, and older rows that arrive at
/// the top must not move what the person is looking at.
public enum RoomScroll {
    /// True when the viewport is within `threshold` of the top of content that is taller than the viewport.
    public static func nearTop(y: Double, document: Double, visible: Double, threshold: Double = 120) -> Bool {
        document > visible && y <= threshold
    }

    /// The offset that keeps the same row under the eye after the document grew at its top (rows prepended). A document that
    /// shrank or stayed put leaves the offset alone.
    public static func afterPrepend(y: Double, oldDocument: Double, newDocument: Double) -> Double {
        newDocument > oldDocument ? y + (newDocument - oldDocument) : y
    }

    /// The offset that restores a distance from the bottom, clamped to the content.
    public static func restored(fromBottom target: Double, document: Double, visible: Double) -> Double {
        min(max(0, document - visible - target), max(0, document - visible))
    }
}
