import Foundation

/// A label in use and how many ponds carry it (`GET /native/labels`).
public struct PondLabelCount: Sendable, Equatable, Decodable, Hashable {
    public var label: String
    public var count: Int
    public init(label: String, count: Int) { self.label = label; self.count = count }
}

/// What the sidebar's Ponds list shows: hidden ponds leave it unless asked for, an optional label narrows it, and the
/// caller's order (newest first) is kept. Pure, so CI pins it.
public enum PondFilter {
    public static let maxLabelLength = 24
    public static let maxLabelsPerPond = 8

    public struct Entry: Sendable, Equatable {
        public var name: String
        public var hidden: Bool
        public var labels: [String]
        public init(name: String, hidden: Bool = false, labels: [String] = []) {
            self.name = name; self.hidden = hidden; self.labels = labels
        }
    }

    public struct Result: Sendable, Equatable {
        /// The names to list, in the order given.
        public var names: [String]
        /// Hidden ponds the list leaves out (the "N hidden" row), counting only those the label filter would show.
        public var hiddenCount: Int
    }

    public static func apply(_ entries: [Entry], label: String?, showHidden: Bool) -> Result {
        let wanted = label.flatMap { l in l.isEmpty ? nil : l.lowercased() }
        let matching = entries.filter { e in
            wanted.map { w in e.labels.contains { $0.lowercased() == w } } ?? true
        }
        let shown = matching.filter { showHidden || !$0.hidden }
        return Result(names: shown.map(\.name), hiddenCount: showHidden ? 0 : matching.count - shown.count)
    }

    /// A label as typed: trimmed, 1-24 characters; nil when empty or too long.
    public static func clean(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || t.count > maxLabelLength ? nil : t
    }

    /// The labels after adding one: the same label (any case) is not added twice, and a ninth is refused.
    public static func adding(_ text: String, to labels: [String]) -> [String]? {
        guard let t = clean(text) else { return nil }
        if labels.contains(where: { $0.lowercased() == t.lowercased() }) { return labels }
        return labels.count >= maxLabelsPerPond ? nil : labels + [t]
    }

    /// Chips for the filter menu and the label popover: every label in use, with a count.
    public static func counts(_ entries: [Entry]) -> [PondLabelCount] {
        var seen: [String: PondLabelCount] = [:]
        for e in entries {
            for l in Set(e.labels.map { $0.lowercased() }) {
                let shown = e.labels.first { $0.lowercased() == l } ?? l
                seen[l, default: PondLabelCount(label: shown, count: 0)].count += 1
            }
        }
        return seen.values.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }
}
