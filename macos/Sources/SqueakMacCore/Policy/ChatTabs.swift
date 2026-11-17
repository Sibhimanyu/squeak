import Foundation

/// The chat tab row's pure rules (DESIGN.md §8.10): which tab opens when the open one is closed, and whether a tab may
/// be closed at all. The row itself keeps `WorkspaceTabOrder`'s positions.
public enum ChatTabs {
    /// A cheap animation value for the strip: changes when the tabs (or their order) do, with no array to compare.
    public static func token<S: Sequence>(_ keys: S) -> Int where S.Element == String {
        var hash: UInt64 = 14695981039346656037
        for key in keys {
            for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
            hash = (hash ^ 0xFF) &* 1099511628211
        }
        return Int(truncatingIfNeeded: hash)
    }

    /// Any chat tab can be closed, the last included (the chat is untouched; the tab is only hidden).
    public static func canClose(shown: Int) -> Bool { shown >= 1 }

    /// Where closing the stream's only chat tab leads: to a file or review tab open in the same stream, else the
    /// pond's overview page (the stream row is then not highlighted: `SidebarSelection`).
    public enum AfterLast: Equatable, Sendable { case showFile, pondPage }
    public static func afterClosingLast(fileTabOpen: Bool) -> AfterLast { fileTabOpen ? .showFile : .pondPage }

    /// The tab to select after closing `closing` from `shown` (in row order): none when another tab is the open one,
    /// else the neighbour on the right, else the one on the left.
    public static func selectionAfterClosing<ID: Equatable>(_ closing: ID, selected: ID?, shown: [ID]) -> ID? {
        guard shown.count > 1, closing == selected, let at = shown.firstIndex(of: closing) else { return nil }
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

/// Tab widths for every strip (centre chats, right, bottom; DESIGN.md 8.10). A tab hugs its content: equal 10pt side
/// padding, icon, 6pt gap, title, 4pt gap, a 14pt close slot (reserved, shown on hover only). No tab is ever wider than
/// it needs to be. Only when the strip genuinely runs out of room do titles truncate, and then the longest tabs give
/// way first, down to a floor that still shows the icon and a few characters (`cap(naturals:available:)`).
public enum ChatTabWidth {
    public static let leadingPad: Double = 7
    public static let trailingPad: Double = 7
    public static let iconSlot: Double = 16
    public static let iconGap: Double = 6
    public static let closeGap: Double = 4
    public static let closeSlot: Double = 14
    /// A title never shows more than this, however much room there is.
    public static let maxTitle: Double = 220
    public static let minTitle: Double = 44

    /// Everything in a tab that is not its title.
    public static let chrome: Double = leadingPad + iconSlot + iconGap + closeGap + closeSlot + trailingPad
    /// The narrowest a tab is drawn: its chrome and a few characters.
    public static let minWidth: Double = chrome + minTitle

    /// A tab's natural width for a title that measures `titleWidth` points.
    public static func natural(titleWidth: Double) -> Double {
        chrome + min(max(titleWidth, 0), maxTitle)
    }

    /// The width a tab is drawn at: it hugs its content (`natural`, plus `extra` for anything after the title such as a
    /// badge or dirty dot), never under `minWidth` and never over `cap` (infinity while the strip has room). A cap below
    /// the floor loses to the floor, so a crowded strip scrolls instead of squashing tabs.
    public static func width(titleWidth: Double, extra: Double = 0, cap: Double = .infinity) -> Double {
        let hug = max(natural(titleWidth: titleWidth) + max(extra, 0), minWidth)
        return max(min(hug, cap), minWidth)
    }

    /// The widest any one tab may be so that all of `naturals` fit in `available` points: infinity while they already
    /// fit (nothing truncates); otherwise the longest tabs are cut back to a shared cap (shorter ones keep their own
    /// width, so no room is left empty), never below `minWidth`.
    public static func cap(naturals: [Double], available: Double) -> Double {
        guard !naturals.isEmpty, available.isFinite, available > 0 else { return .infinity }
        let total = naturals.reduce(0, +)
        if total <= available { return .infinity }
        var low = minWidth, high = naturals.max() ?? minWidth
        guard naturals.reduce(0, { $0 + min($1, low) }) < available else { return low }
        for _ in 0..<40 {
            let mid = (low + high) / 2
            if naturals.reduce(0, { $0 + min($1, mid) }) <= available { low = mid } else { high = mid }
        }
        return low.rounded(.down)
    }
}

/// A dock strip's tabs never squash below `ChatTabWidth.minWidth`, and the strip scrolls when they still do not fit. A
/// trailing accessory (a shortcut hint) is only worth the room when every tab still fits beside it.
public enum TabStripFit {
    public static let tabMin: Double = ChatTabWidth.minWidth
    public static let titleMin: Double = ChatTabWidth.minTitle

    /// Whether a trailing accessory `accessory` points wide fits beside `tabs` tabs at their minimum, the strip's own
    /// leading slot and the "+" button, in a strip `strip` points wide. Unknown width (0) says no.
    public static func showsAccessory(strip: Double, tabs: Int, leading: Double, plus: Double = 36, accessory: Double) -> Bool {
        guard strip.isFinite, strip > 0 else { return false }
        return strip >= leading + plus + Double(max(0, tabs)) * tabMin + accessory
    }
}

/// What a tab is doing, for the mark in its trailing slot (DESIGN.md 8.10).
public enum TabActivity: Equatable, Sendable {
    case idle, working, needsYou
}

/// What the tab's reserved 14pt trailing slot shows. The slot never changes size; the close button and the activity
/// mark share it, so hovering swaps them (the view crossfades) and the tab never shifts.
public struct TabSlotContent: Equatable, Sendable {
    public var close: Bool
    public var workingGlyph: Bool
    public var warning: Bool

    /// Hovered: the close button only. Otherwise working shows the tide glyph, needs-you the warning triangle, idle nothing.
    public static func of(_ activity: TabActivity, hovered: Bool) -> TabSlotContent {
        if hovered { return TabSlotContent(close: true, workingGlyph: false, warning: false) }
        return TabSlotContent(close: false, workingGlyph: activity == .working, warning: activity == .needsYou)
    }

    /// A chat's tab from its mark: working (also background work) and waiting; everything else is quiet.
    public static func activity(of mark: ChatMarkKind?) -> TabActivity {
        switch mark {
        case .working?: .working
        case .waiting?: .needsYou
        default: .idle
        }
    }
}
