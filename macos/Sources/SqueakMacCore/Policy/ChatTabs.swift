import Foundation

/// The chat tab row's pure rules (DESIGN.md §8.10): which tab opens when the open one is closed, and whether a tab may
/// be closed at all. The row itself keeps `WorkspaceTabOrder`'s positions.
public enum ChatTabs {
    /// A workspace always keeps one tab, so the last cannot be closed.
    /// A cheap animation value for the strip: changes when the tabs (or their order) do, with no array to compare.
    public static func token<S: Sequence>(_ keys: S) -> Int where S.Element == String {
        var hash: UInt64 = 14695981039346656037
        for key in keys {
            for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
            hash = (hash ^ 0xFF) &* 1099511628211
        }
        return Int(truncatingIfNeeded: hash)
    }

    public static func canClose(shown: Int) -> Bool { shown > 1 }

    /// The tab to select after closing `closing` from `shown` (in row order): none when another tab is the open one,
    /// else the neighbour on the right, else the one on the left.
    public static func selectionAfterClosing<ID: Equatable>(_ closing: ID, selected: ID?, shown: [ID]) -> ID? {
        guard canClose(shown: shown.count), closing == selected, let at = shown.firstIndex(of: closing) else { return nil }
        if at + 1 < shown.count { return shown[at + 1] }
        return shown[at - 1]
    }

    /// ⌃Tab / ⌃⇧Tab: the tab `by` places from the selected one, wrapping round; the first when none is selected.
    public static func step<ID: Equatable>(from selected: ID?, in shown: [ID], by delta: Int) -> ID? {
        guard !shown.isEmpty else { return nil }
        guard let selected, let at = shown.firstIndex(of: selected) else { return shown[0] }
        let n = shown.count
        return shown[((at + delta) % n + n) % n]
    }
}

/// ⌘W: closes the open chat tab when the main window is key and a tab can close, else the window as before.
public enum CloseRouting {
    public enum Target: Equatable, Sendable { case tab, window }
    public static func route(mainWindowKey: Bool, tabClosable: Bool) -> Target {
        mainWindowKey && tabClosable ? .tab : .window
    }
}

public enum ModelPicking {
    /// ⇧⌘E: the model's next thinking level, wrapping; the first level when none is set.
    public static func nextLevel(after current: String?, in levels: [String]) -> String? {
        guard !levels.isEmpty else { return nil }
        guard let current, let at = levels.firstIndex(of: current) else { return levels[0] }
        return levels[(at + 1) % levels.count]
    }
}

/// Chat tab widths (DESIGN.md 8.10): a tab never passes `maxWidth` (title text at most `maxTitle`); with many tabs they
/// shrink evenly down to `minWidth`, and only then does the strip scroll.
public enum ChatTabWidth {
    public static let maxWidth: Double = 260
    public static let minWidth: Double = 120
    public static let maxTitle: Double = 200

    /// Each chat tab width given `count` tabs sharing `available` points.
    public static func width(count: Int, available: Double) -> Double {
        guard count > 0, available > 0 else { return maxWidth }
        return min(maxWidth, max(minWidth, (available / Double(count)).rounded(.down)))
    }
}
