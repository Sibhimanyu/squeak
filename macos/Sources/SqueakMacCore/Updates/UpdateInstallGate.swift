import Foundation

/// When pressing Install would lose something. Squeak's chats live in the session host (a separate launch agent), so
/// an app update never stops them; what dies with the app is a terminal tab whose shell is running a command, so only
/// those make Install ask. Pure: the app counts the tabs and carries the outcome out.
public enum UpdateInstallGate {
    public enum Step: Equatable, Sendable {
        case installNow
        /// Ask first: this many terminal tabs are running a command.
        case ask(busyTerminals: Int)
        case keepWaiting
        /// Nothing to do (not waiting, or the version waited for is no longer the one on offer).
        case idle
    }

    public enum Choice: Equatable, Sendable { case installWhenFree, installNow, cancel }

    public static let waitingKey = "squeak.update.installWhenFreeVersion"

    /// The press on Install (or Restart).
    public static func onPress(busyTerminals: Int) -> Step {
        busyTerminals > 0 ? .ask(busyTerminals: busyTerminals) : .installNow
    }

    /// One look while "Install when free" waits for `version`.
    public static func onPoll(busyTerminals: Int, waitingFor: String?, offered: String?) -> Step {
        guard let waitingFor, !waitingFor.isEmpty else { return .idle }
        // Sparkle has not offered anything yet (just relaunched): keep waiting rather than forget the choice.
        guard let offered else { return .keepWaiting }
        guard waitingFor == offered else { return .idle }
        return busyTerminals > 0 ? .keepWaiting : .installNow
    }

    /// What the answer to the question does: the version to wait for (nil = none) and whether to install now.
    public static func apply(_ choice: Choice, version: String) -> (waitingFor: String?, install: Bool) {
        switch choice {
        case .installWhenFree: (version, false)
        case .installNow: (nil, true)
        case .cancel: (nil, false)
        }
    }

    public static func question(busyTerminals n: Int) -> String {
        n == 1 ? "1 terminal tab is running a command. Installing closes it."
               : "\(n) terminal tabs are running commands. Installing closes them."
    }

    /// The row's muted line: the version, and what keeps running (chats are in the host, not the app).
    public static func rowLine(version: String, chatsWorking: Int, waiting: Bool) -> String {
        if waiting { return "Installs when your terminals are free" }
        guard chatsWorking > 0 else { return "Update \(version) ready" }
        return "Update \(version) ready · \(chatsWorking) \(chatsWorking == 1 ? "chat keeps" : "chats keep") working"
    }

    /// Terminal tabs whose shell is running something other than itself (the pty's foreground group is not the shell's).
    public static func busyTerminals(_ tabs: [(shellPid: Int32, foregroundGroup: Int32?)]) -> Int {
        tabs.filter { TerminalShell.closeDecision(shellPid: $0.shellPid, foregroundGroup: $0.foregroundGroup) == .confirm }.count
    }
}
