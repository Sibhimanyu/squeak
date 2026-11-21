import Foundation

/// What decides whether the set of chats changed: the keys, and which of them are archived. A swap (one chat
/// gone, another arrived, same count) is a change; a state flip such as working to ready is not.
public struct SessionSetSignature: Equatable, Sendable {
    public var keys: Set<SessionKey>
    public var archived: Set<SessionKey>
    public init(keys: Set<SessionKey> = [], archived: Set<SessionKey> = []) {
        self.keys = keys
        self.archived = archived
    }
    public init(_ sessions: [HostSession]) {
        keys = Set(sessions.map(\.key))
        archived = Set(ThreadArchive.archived(sessions).map(\.key))
    }
}

/// A value and a revision that moves only when the value really changes: views key `.task(id:)` on the revision
/// instead of rebuilding and comparing the value (a key list, a title list) in every body.
public struct RevisionTracker<Value: Equatable> {
    public private(set) var value: Value
    public private(set) var revision = 0
    public init(_ initial: Value) { value = initial }

    /// True when `fresh` differs from the last value (and the revision moved).
    @discardableResult
    public mutating func update(_ fresh: Value) -> Bool {
        guard fresh != value else { return false }
        value = fresh
        revision &+= 1
        return true
    }
}

/// Listing changes, as the pruning and the open-when-listed wait see them.
public enum SessionSetDiff {
    /// Keys that left, and keys that arrived, between two signatures.
    public static func delta(from old: SessionSetSignature, to new: SessionSetSignature) -> (removed: Set<SessionKey>, added: Set<SessionKey>) {
        (old.keys.subtracting(new.keys), new.keys.subtracting(old.keys))
    }

    /// Pruning needs a real list: an empty one is a catalog not read yet, which would forget every saved tab.
    public static func shouldPrune(_ new: SessionSetSignature) -> Bool { !new.keys.isEmpty }
}

/// The strip's width cap, measured once per (titles, width bucket) instead of once per body.
public final class TabCapMemo {
    public struct Key: Equatable {
        public var titles: [String]
        public var widthBucket: Int
        public init(titles: [String], width: Double, bucket: Double = 8) {
            self.titles = titles
            widthBucket = width.isFinite ? Int((width / bucket).rounded(.down)) : -1
        }
    }
    private var last: (key: Key, value: Double)?
    public private(set) var computes = 0
    public init() {}

    public func value(titles: [String], width: Double, compute: () -> Double) -> Double {
        let key = Key(titles: titles, width: width)
        if let last, last.key == key { return last.value }
        let out = compute()
        last = (key, out)
        computes += 1
        return out
    }
}

/// Holds a value while a surface is hidden and hands the latest over once when it shows again. Nothing is dropped:
/// readers that are not the UI ask `current(shown:)` and see the newest value either way.
public struct HiddenHold<Value> {
    private var held: Value?
    public init() {}

    /// The value to publish now, or nil when it was held back.
    public mutating func offer(_ value: Value, open: Bool) -> Value? {
        if open { held = nil; return value }
        held = value
        return nil
    }

    /// The held value, once, when the surface shows again.
    public mutating func release() -> Value? {
        defer { held = nil }
        return held
    }

    public func current(shown: Value) -> Value { held ?? shown }
    public var isHolding: Bool { held != nil }
}

/// The tab strip's place for a workspace that has no chat listed yet, built from the host's workspace row (or, for a
/// pond's Main, its project row). Same id the sidebar tree gives the workspace once a chat lists, so saved tabs carry over.
public enum StripPlaceFromRow {
    public static func place(project: NativeProject, workspace: NativeWorkspace?) -> (project: SidebarProject, workspace: SidebarWorkspace) {
        let path = workspace?.path ?? project.rootPath
        var w = SidebarWorkspace(
            id: "\(project.name)/\(path)",
            name: workspace?.name ?? (project.rootPath as NSString).lastPathComponent,
            title: workspace?.title,
            branch: workspace?.branch ?? project.mainBranch,
            chats: [], repo: project.name, foldedMark: nil)
        w.isMain = workspace == nil
        return (SidebarProject(name: project.name, workspaces: [w]), w)
    }
}
