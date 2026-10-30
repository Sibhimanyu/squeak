import Foundation

/// When Squeak is a regular app (Dock icon, its own menu bar) and how it takes the menu bar. Pure, so the
/// timing rules behind two real bugs are tested: a window closed moments after it opened came back, and a
/// window opened from Finder or Spotlight left Finder's menus in the menu bar.
public enum ActivationRules {
    /// How long a window asked for by code may take to appear before "no window" is believed.
    public static let windowGrace: TimeInterval = 3
    /// A reopen arriving this soon after Squeak opened itself through Launch Services is that open's echo.
    public static let selfOpenEcho: TimeInterval = 3

    /// Regular while an app window is open, or one was asked for and may still be appearing. A window closed
    /// after the request cancels it: the close is the newer word, and keeping the Dock icon for it would bring
    /// back the menu bar (and, through the reopen it causes, the window).
    public static func wantsRegular(
        hasWindow: Bool, showRequestedAt: Date?, lastCloseAt: Date?, now: Date
    ) -> Bool {
        if hasWindow { return true }
        guard let requested = showRequestedAt, now.timeIntervalSince(requested) < windowGrace else { return false }
        if let closed = lastCloseAt, closed >= requested { return false }
        return true
    }

    public enum MenuBarRoute: Equatable {
        /// Ask AppKit to activate, and fall back to Launch Services if it did not take.
        case activate
        /// Squeak was already frontmost as a menu-bar accessory (Finder, Spotlight or the popover activated it).
        /// Turning regular while active does not redraw the menu bar: the previous app's menus stay. Step out of
        /// the front and come back through Launch Services so the menu bar is rebuilt as Squeak's.
        case deactivateThenReopen
    }

    public static func menuBarRoute(wasActiveAsAccessory: Bool) -> MenuBarRoute {
        wasActiveAsAccessory ? .deactivateThenReopen : .activate
    }

    /// The Launch Services fallback opens Squeak itself, which AppKit delivers as a reopen. Only worth doing
    /// while a window is on screen or on its way; with none, the reopen it causes would open the window again.
    public static func shouldReopenSelf(menuBarIsOurs: Bool, windowShownOrPending: Bool) -> Bool {
        !menuBarIsOurs && windowShownOrPending
    }
}
