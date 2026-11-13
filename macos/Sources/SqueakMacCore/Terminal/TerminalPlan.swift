import Foundation

/// What the terminal panel does about its tabs, kept pure so the rules are tested: a workspace is never left without a
/// terminal, and showing the panel again shows the tab that was there.
public extension TerminalRegistry {
    /// ⌘J / the panel appearing or the workspace changing: the selected tab (no new one) when the workspace has any,
    /// else a fresh one. `spawn` is true only for a tab that has no shell yet.
    mutating func show(_ workspace: String) -> (tab: TerminalTab, spawn: Bool) {
        let existed = !tabs(workspace).isEmpty
        return (ensure(workspace), !existed)
    }

    /// A tab was closed or its shell exited: it goes, and when it was the workspace's last one a replacement is
    /// returned (already added and selected) for the caller to start a shell in. nil when other tabs remain or the
    /// tab was unknown.
    mutating func end(_ workspace: String, _ id: UUID) -> TerminalTab? {
        guard close(workspace, id) else { return nil }
        return tabs(workspace).isEmpty ? add(workspace) : nil
    }
}

public enum TerminalPlan {
    /// A replacement shell is started only when the one that ended had lived this long; sooner would loop.
    public static let minimumLife: TimeInterval = 0.5

    public static func shouldRespawn(lived: TimeInterval) -> Bool { lived >= minimumLife }

    /// The panel shows the "shell stopped" message (never a blank body) when the workspace has no tab and the
    /// respawn guard is what left it so.
    public static func showsStopped(hasTabs: Bool, guardStopped: Bool) -> Bool { !hasTabs && guardStopped }

    public static func stoppedMessage(exitCode: Int32?) -> String {
        guard let exitCode else { return "The shell stopped right away." }
        return "The shell stopped right away (exit status \(exitCode))."
    }
}
