import Foundation

/// Why an open diff, file or artifact tab has nothing left to show. The tab says so and offers Close; it never closes itself.
public enum PondTabGone: String, Equatable, Sendable {
    case merged, duckDeleted, fileRemoved, artifactDeleted, noDiff

    /// The state in two or three words, shown as the tab's heading.
    public var title: String {
        switch self {
        case .merged: "Merged"
        case .duckDeleted: "Duck deleted"
        case .fileRemoved: "File removed"
        case .artifactDeleted: "Artifact deleted"
        case .noDiff: "No changes"
        }
    }

    /// One sentence under the heading.
    public var detail: String {
        switch self {
        case .merged: "This Duck's branch was merged, so there is nothing left to review."
        case .duckDeleted: "The Duck that made these changes was deleted."
        case .fileRemoved: "This file is no longer on disk."
        case .artifactDeleted: "This artifact is no longer in the Pond."
        case .noDiff: "This file no longer differs from its base."
        }
    }
}

/// What the host and daemon say about one tab's source right now.
public enum PondTabSource: Equatable, Sendable {
    /// Not read yet, or the read failed: neither updated nor gone.
    case unknown
    /// Present; `stamp` changes whenever its content does.
    case present(stamp: String)
    case gone(PondTabGone)
}

/// Turns the existing streams (the Duck's changes and git status, the file on disk, the Pond's artifact list) into a
/// `PondTabSource`. Pure: the Mac app reads the values, these decide.
public enum PondTabSources {
    /// A diff tab (`path` set) or review-all tab (`path` nil). `changes` is nil until the list has been read.
    public static func diff(duckExists: Bool, merged: Bool, changes: [DaemonChanges.File]?, path: String?) -> PondTabSource {
        guard duckExists else { return .gone(.duckDeleted) }
        if merged { return .gone(.merged) }
        guard let changes else { return .unknown }
        guard let path else {
            return .present(stamp: changes.map { "\($0.path)=\($0.status)/\($0.added)/\($0.removed)" }.joined(separator: ";"))
        }
        guard let file = changes.first(where: { $0.path == path }) else { return .gone(.noDiff) }
        return .present(stamp: "\(file.status)/\(file.added)/\(file.removed)")
    }

    /// A file tab. `checked` is false before the disk has been looked at; `stamp` nil after it means the file is gone.
    public static func file(checked: Bool, stamp: FileStamp?) -> PondTabSource {
        guard checked else { return .unknown }
        guard let stamp else { return .gone(.fileRemoved) }
        return .present(stamp: "\(stamp.modified)/\(stamp.size)")
    }

    /// An artifact tab of this Mac's own Pond. `listed` is the row in the Pond's artifact list; `loaded` once the list was read.
    public static func artifact(loaded: Bool, failed: Bool, listed: ArtifactItem?) -> PondTabSource {
        guard loaded, !failed else { return .unknown }
        guard let listed else { return .gone(.artifactDeleted) }
        return .present(stamp: "\(listed.modifiedAt.timeIntervalSince1970)/\(listed.size)")
    }
}

/// Which open item tabs changed since the person last looked, and which have lost their source.
///
/// - The first reading of a tab is its baseline: opening a tab never marks it.
/// - A changed stamp marks a tab "updated" unless the person is on it; the mark stays until they visit.
/// - A source must read gone twice in a row before the tab says so, so a file mid-save or a list mid-refresh does not
///   flash a false "removed". A source that comes back clears the state.
/// - Nothing here closes a tab.
public struct PondLiveTabs: Equatable, Sendable {
    /// Consecutive gone readings needed before a tab shows its gone state.
    public static let goneReadings = 2

    private struct GoneRun: Equatable, Sendable { var reason: PondTabGone; var count: Int }

    private var stamps: [TabItem: String] = [:]
    private var updated: Set<TabItem> = []
    private var runs: [TabItem: GoneRun] = [:]
    private var gone: [TabItem: PondTabGone] = [:]

    public init() {}

    public func isUpdated(_ item: TabItem) -> Bool { updated.contains(item) }
    public func goneState(_ item: TabItem) -> PondTabGone? { gone[item] }

    public mutating func observe(_ item: TabItem, _ source: PondTabSource, viewing: Bool) {
        switch source {
        case .unknown:
            return
        case .present(let stamp):
            runs[item] = nil
            gone[item] = nil
            if let last = stamps[item], last != stamp, !viewing { updated.insert(item) }
            stamps[item] = stamp
            if viewing { updated.remove(item) }
        case .gone(let reason):
            let count = (runs[item].flatMap { $0.reason == reason ? $0.count : nil } ?? 0) + 1
            runs[item] = GoneRun(reason: reason, count: count)
            if count >= Self.goneReadings { gone[item] = reason; updated.remove(item) }
        }
    }

    /// The person opened the tab: its mark goes.
    public mutating func visit(_ item: TabItem) { updated.remove(item) }

    /// Drops what is remembered for tabs that are no longer open.
    public mutating func retain(_ open: [TabItem]) {
        let keep = Set(open)
        stamps = stamps.filter { keep.contains($0.key) }
        updated = updated.filter(keep.contains)
        runs = runs.filter { keep.contains($0.key) }
        gone = gone.filter { keep.contains($0.key) }
    }
}
