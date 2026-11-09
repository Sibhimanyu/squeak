import Foundation

/// The diff tabs in the centre's tab row (DESIGN.md §8.10): one file's whole diff against the workspace's base, or
/// every changed file stacked. Which are open, which one shows, what was closed (⇧⌘T brings it back), and which
/// file sections of the stacked view are folded. Pure, so the rules are tested without a window.
public struct DiffTabs: Equatable, Sendable {
    public enum Target: Hashable, Sendable {
        case file(String)
        case all
    }

    public private(set) var open: [Target] = []
    public private(set) var active: Target?
    public private(set) var closed: [Target] = []
    public private(set) var folded: Set<String> = []
    /// How many closed tabs ⇧⌘T can still bring back.
    public static let closedLimit = 10

    public init() {}

    public var hasClosed: Bool { !closed.isEmpty }

    /// Opens the tab (or finds it) and shows it.
    public mutating func show(_ target: Target) {
        if !open.contains(target) { open.append(target) }
        closed.removeAll { $0 == target }
        active = target
    }

    /// Something else (a chat, a file) takes the centre; the tabs stay open.
    public mutating func deactivate() { active = nil }

    /// Closes a tab; if it was showing, the tab before it (or after, for the first) shows, else nothing.
    public mutating func close(_ target: Target) {
        guard let index = open.firstIndex(of: target) else { return }
        open.remove(at: index)
        closed.removeAll { $0 == target }
        closed.append(target)
        if closed.count > Self.closedLimit { closed.removeFirst(closed.count - Self.closedLimit) }
        if active == target { active = open.isEmpty ? nil : open[min(max(index - 1, 0), open.count - 1)] }
    }

    /// The most recently closed tab, shown again.
    @discardableResult
    public mutating func reopen() -> Target? {
        guard let last = closed.last else { return nil }
        show(last)
        return last
    }

    /// A file that is no longer changed has nothing to show: its tab goes, and is not offered again.
    public mutating func prune(changed: Set<String>) {
        func gone(_ t: Target) -> Bool { if case .file(let p) = t { return !changed.contains(p) } else { return false } }
        let wasActive = active
        open.removeAll(where: gone)
        closed.removeAll(where: gone)
        if let wasActive, gone(wasActive) { active = open.last }
        folded = folded.filter(changed.contains)
    }

    public mutating func toggleFold(_ path: String) {
        if folded.contains(path) { folded.remove(path) } else { folded.insert(path) }
    }

    public func isFolded(_ path: String) -> Bool { folded.contains(path) }
}

/// How much of a big diff is drawn before "Show full file".
public enum DiffWindow {
    public static let cap = 1500

    public static func visible(total: Int, showingAll: Bool) -> Int { showingAll ? total : min(total, cap) }
    public static func hidden(total: Int, showingAll: Bool) -> Int { total - visible(total: total, showingAll: showingAll) }
}
