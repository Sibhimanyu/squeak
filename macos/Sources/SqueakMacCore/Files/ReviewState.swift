import Foundation

/// The Review view that replaces the centre's content (DESIGN.md §8.10): every changed file's diff stacked, with a
/// file list beside it. Whether it is showing, which file it was opened on (the list highlights it and the stack
/// scrolls to it), and which file sections are folded. Pure, so the rules are tested without a window.
public struct ReviewState: Equatable, Sendable {
    public private(set) var isOpen = false
    public private(set) var focus: String?
    public private(set) var folded: Set<String> = []

    public init() {}

    /// Opens the review, on one file or (nil) at the top.
    public mutating func open(file: String? = nil) { isOpen = true; focus = file }

    /// Picks a file in the list while the review is showing.
    public mutating func focus(_ path: String) { focus = path }

    public mutating func close() { isOpen = false; focus = nil }

    /// A file that is no longer changed has nothing to show.
    public mutating func prune(changed: Set<String>) {
        folded = folded.filter(changed.contains)
        if let f = focus, !changed.contains(f) { focus = nil }
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
