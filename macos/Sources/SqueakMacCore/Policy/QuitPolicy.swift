import Foundation

/// What to do when the app is asked to terminate. Squeak lives in the menu bar, so a quit aimed
/// at its windows (Cmd-Q, the Dock's Quit, Cmd-Tab then Q) closes them and leaves it running;
/// the popover's Quit row, Option-Cmd-Q, logout/restart/shutdown and an update really quit.
public enum QuitPolicy {
    public enum Decision: Equatable, Sendable {
        case quit
        case closeWindows
    }

    /// - explicitQuit: the user chose a full quit inside the app (popover row, "Quit Squeak Completely").
    /// - systemQuit: a `quit` Apple event carrying a logout, restart or shutdown reason. The Dock and
    ///   the app switcher send the same event with no reason, and those count as window quits.
    /// - updating: Sparkle is installing an update and needs the app to exit.
    /// - hasAppWindows: a real window (conversation, Settings, Welcome) is open.
    public static func decide(explicitQuit: Bool, systemQuit: Bool, updating: Bool, hasAppWindows: Bool) -> Decision {
        if explicitQuit || systemQuit || updating { return .quit }
        // No window open: nothing to close, so the user meant the whole app.
        return hasAppWindows ? .closeWindows : .quit
    }

    /// Whether Sparkle may reopen the app once it has installed: never after a quit the person chose.
    public static func shouldRelaunchAfterUpdate(explicitQuit: Bool, userQuit: Bool) -> Bool { !(explicitQuit || userQuit) }

    /// Whether a marker for the next launch should be written as the app quits: for an update's
    /// quit, and for a plain quit while an update waits to install on it.
    public static func shouldSaveRestore(decision: Decision, updating: Bool, installPending: Bool) -> Bool {
        decision == .quit && (updating || installPending)
    }

    /// Whether a `quit` Apple event's `kAEQuitReason` names logout, restart or shutdown.
    public static func isSystemQuitReason(_ reason: UInt32?) -> Bool {
        guard let reason else { return false }
        // kAELogOut, kAEReallyLogOut, kAEShowRestartDialog, kAEShowShutdownDialog, kAERestart, kAEShutDown
        let codes: Set<String> = ["logo", "rlgo", "rrst", "rsdn", "rest", "shut"]
        let chars = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((reason >> UInt32($0)) & 0xff))) }
        return codes.contains(String(chars))
    }
}
