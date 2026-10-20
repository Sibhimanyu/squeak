import Foundation

/// What to do when the app is asked to terminate. Squeak lives in the menu bar, so a Cmd-Q aimed
/// at one of its windows should close them and leave the duck running; every other route to a
/// quit (the popover's Quit row, logout, the Dock, AppleScript, an update) must really quit.
public enum QuitPolicy {
    public enum Decision: Equatable, Sendable {
        case quit
        case closeWindows
    }

    /// - explicitQuit: the user chose a full quit inside the app (popover row, "Quit Squeak Completely").
    /// - externalQuitEvent: the termination arrived as a `quit` Apple event (logout, shutdown, Dock, osascript).
    /// - updating: Sparkle is installing an update and needs the app to exit.
    /// - hasAppWindows: a real window (conversation, Settings, Welcome) is open.
    public static func decide(explicitQuit: Bool, externalQuitEvent: Bool, updating: Bool, hasAppWindows: Bool) -> Decision {
        if explicitQuit || externalQuitEvent || updating { return .quit }
        // No window open: Cmd-Q can only come from the menu bar or outside, so it is a real quit.
        return hasAppWindows ? .closeWindows : .quit
    }
}
