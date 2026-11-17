import Foundation

/// Whether the app opens its main window by itself when it starts, and whether that window comes back in full screen.
/// Squeak opens its window when a person starts it (Finder, Dock, Spotlight, `open`, a direct run); it stays in the
/// menu bar when macOS started it at login, and leaves capture/demo runs and the Welcome flow as they were.
public enum LaunchWindowPolicy {
    public enum Source: Equatable, Sendable {
        /// Started by the person.
        case user
        /// Started by macOS as a login item (`SMAppService.mainApp`): the open-application event carries
        /// `keyAELaunchedAsLogInItem`.
        case loginItem
    }

    /// Where the previous run's update marker says the window stood; nil = this is not the relaunch after an update.
    public static func opensWindow(source: Source, captureOrDemo: Bool, welcomeShowing: Bool,
                                   updateRelaunchWindow: UpdateRestoreMarker.Window? = nil) -> Bool {
        if captureOrDemo || welcomeShowing { return false }
        if source == .loginItem { return false }
        // After an update the app comes back to what it showed: the window only if it was open (settings and
        // Welcome are put back by the update restore itself).
        if let was = updateRelaunchWindow { return was == .conversation }
        return true
    }

    /// Whether the main window, once on screen, is put back in full screen: it was in full screen when the app last
    /// went down, and this is the first time it opens in this run. Never in capture/demo runs.
    public static func restoresFullScreen(saved: Bool, alreadyRestored: Bool, captureOrDemo: Bool) -> Bool {
        saved && !alreadyRestored && !captureOrDemo
    }

    /// The flag to keep when a window leaves full screen. A leave caused by the app quitting is not the person's
    /// choice, so the saved flag stays.
    public static func savedFullScreen(current: Bool, leavingBecauseAppIsQuitting: Bool, previous: Bool) -> Bool {
        if !current && leavingBecauseAppIsQuitting { return previous }
        return current
    }

    /// Full screen is entered only by a regular app whose window is on screen and key; earlier the transition fails.
    public static func canRestoreFullScreen(appIsRegular: Bool, windowVisible: Bool, windowIsKey: Bool) -> Bool {
        appIsRegular && windowVisible && windowIsKey
    }

    public static let fullScreenKey = "conversationWindowFullScreen"
}
