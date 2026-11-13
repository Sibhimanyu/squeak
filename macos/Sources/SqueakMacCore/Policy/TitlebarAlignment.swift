import Foundation

/// Windowed mode: the system traffic lights sit at the titlebar's own height, the top row (arrows, sidebar toggle,
/// breadcrumb) is a fixed-height strip from the content's top edge, so their centre lines can differ. Every row is a
/// column background that cannot move up, so the buttons are moved to the row's centre line instead. Pure part.
public enum TitlebarAlignment {
    /// How far (points, positive = down) the buttons must move so their centre is the row's centre.
    /// `buttonMidFromTop` is the close button's centre measured down from the window's top edge.
    public static func downShift(buttonMidFromTop: Double, rowHeight: Double) -> Double {
        rowHeight / 2 - buttonMidFromTop
    }

    /// The row's top inset that would centre it on the buttons (negative = above the content's top): the inverse view
    /// of `downShift`, kept for layouts that can shift their row instead.
    public static func rowTopInset(buttonMidFromTop: Double, rowHeight: Double) -> Double {
        buttonMidFromTop - rowHeight / 2
    }

    /// Ignore a shift too small to see (or not finite), so a re-layout never makes the buttons jitter.
    public static func shouldMove(_ shift: Double) -> Bool { shift.isFinite && abs(shift) >= 0.25 }

    /// Where a windowed system button goes, absolute, in WINDOW coordinates (bottom-left origin): the same column as
    /// full screen's own controls (`FullScreenLights.lightX`, the duck's column; `buttonWidth` is the button's frame, whose
    /// 12pt circle is centred in it) and the centre line of the top row, which hangs from the window's top edge.
    /// Index 0 close, 1 minimise, 2 zoom; macOS's 20pt pitch is kept.
    public static func windowedButtonOrigin(index: Int, buttonWidth: Double, buttonHeight: Double,
                                            windowHeight: Double, rowHeight: Double) -> (x: Double, y: Double) {
        (FullScreenLights.lightX(index) - (buttonWidth - FullScreenLights.diameter) / 2,
         windowHeight - rowHeight / 2 - buttonHeight / 2)
    }
}
