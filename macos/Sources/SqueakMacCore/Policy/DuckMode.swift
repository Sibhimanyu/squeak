import Foundation

// Flag `ducksOwnBranch` (docs/ponds.md "Ducks own their branch"): ducks, not streams, are what a pond holds, and each
// duck owns its branch. Everything here is pure; the views feed sessions in and draw what comes back. With the flag
// off none of it runs and the stream-first UI is untouched.

/// Where a duck works, as the daemon takes it (`place` on `POST /native/sessions` and `/native/ducks/<id>/place`).
public enum DuckPlace: Equatable, Sendable {
    /// A new branch and working copy; the host names it when `branch` is nil.
    case new(branch: String?)
    /// The branch another duck is on.
    case join(duckId: String)
    /// An existing branch by name.
    case joinBranch(String)
    /// The pond's own folder (read-only for ducks in a git pond).
    case main

    public var json: NativeJSON {
        switch self {
        case .new(let branch):
            if let b = branch?.trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty { return .object(["kind": .string("new"), "branch": .string(b)]) }
            return .object(["kind": .string("new")])
        case .join(let id): return .object(["kind": .string("join"), "duckId": .string(id)])
        case .joinBranch(let b): return .object(["kind": .string("join"), "branch": .string(b)])
        case .main: return .object(["kind": .string("main")])
        }
    }
}

/// One duck as the sidebar and the tab strip list it: its current chat, where it works, and the words for that place.
public struct DuckRow: Equatable, Sendable, Identifiable {
    public static let mainLabel = "main"
    public var session: HostSession
    /// Works in the pond's own folder.
    public var isMain: Bool
    public var id: SessionKey { session.key }
    /// The branch it works on; nil on main or when the host did not say.
    public var branch: String? { isMain ? nil : session.branch.flatMap { $0.isEmpty ? nil : $0 } }
    /// The small mono label: "main" for main, else the branch (empty when unknown).
    public var label: String? { isMain ? Self.mainLabel : branch }
    public var lastActivityAt: Date? { session.lastActivityAt }
    public init(session: HostSession, isMain: Bool) { self.session = session; self.isMain = isMain }
}

public struct DuckGroup: Equatable, Sendable, Identifiable {
    public var label: String
    public var isMain: Bool
    public var rows: [DuckRow]
    public var id: String { isMain ? "\u{0}main" : label }
    public var lastActivityAt: Date? { rows.compactMap(\.lastActivityAt).max() }
}

/// A line of the pond page's "Branches" list.
public struct DuckBranch: Equatable, Sendable, Identifiable {
    public var label: String
    public var isMain: Bool
    public var duckCount: Int
    public var lastActivityAt: Date?
    /// The newest duck's chat on this branch (its PR state is the branch's).
    public var lead: HostSession?
    public var id: String { isMain ? "\u{0}main" : label }
}

/// A line of a "Work with…" menu: a duck, or a branch (with its duck count).
public struct DuckJoinTarget: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case duck(String), branch(String) }
    public var title: String
    public var branch: String
    public var kind: Kind
    public var id: String {
        switch kind { case .duck(let d): "duck:\(d)"; case .branch(let b): "branch:\(b)" }
    }
    public var place: DuckPlace {
        switch kind { case .duck(let d): .join(duckId: d); case .branch(let b): .joinBranch(b) }
    }
}

public enum DuckList {
    /// The pond's ducks, newest activity first (ties by title). A duck with several chats shows its newest; a chat the
    /// daemon gave no duck is its own duck. Archived chats are not ducks here. `main` marks the pond's own folder.
    public static func rows(_ chats: [HostSession], main: MainPlace?) -> [DuckRow] {
        var newest: [String: HostSession] = [:]
        var order: [String] = []
        for s in chats where s.archivedAt == nil {
            let k = s.duckId ?? "chat:\(s.key.stringValue)"
            if let have = newest[k] {
                if newer(s, have) { newest[k] = s }
            } else { newest[k] = s; order.append(k) }
        }
        return order.compactMap { newest[$0] }
            .sorted { a, b in
                switch (a.lastActivityAt, b.lastActivityAt) {
                case let (x?, y?) where x != y: return x > y
                case (nil, .some): return false
                case (.some, nil): return true
                default: return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
                }
            }
            .map { DuckRow(session: $0, isMain: main?.contains($0) ?? false) }
    }

    /// A duck's current chat: the newest not-archived chat with its `duckId` in `pool`; a chat with no duck is itself.
    public static func current(_ s: HostSession, in pool: [HostSession]) -> HostSession {
        guard let id = s.duckId else { return s }
        return pool.filter { $0.duckId == id && $0.archivedAt == nil }.max { newer($1, $0) } ?? s
    }

    /// Chats as ducks, in the order given (a saved tab order is kept): each chat becomes its duck's current chat, a duck
    /// appears once (at its first place), archived chats go. `pool` is every chat that can stand in (default `chats`).
    public static func collapse(_ chats: [HostSession], pool: [HostSession]? = nil) -> [HostSession] {
        let pool = pool ?? chats
        var seen = Set<SessionKey>()
        var out: [HostSession] = []
        for s in chats {
            let c = current(s, in: pool)
            if c.archivedAt == nil, seen.insert(c.key).inserted { out.append(c) }
        }
        return out
    }

    private static func newer(_ a: HostSession, _ b: HostSession) -> Bool {
        (a.lastActivityAt ?? .distantPast) > (b.lastActivityAt ?? .distantPast)
    }

    /// "Group by branch": one group per branch, the group with the newest duck first, ducks newest first inside; ducks
    /// with no known branch go under "main" only when they run in the root, else in a last group without a name.
    public static func groups(_ rows: [DuckRow]) -> [DuckGroup] {
        var by: [String: DuckGroup] = [:]
        var order: [String] = []
        for r in rows {
            let isMain = r.isMain
            let label = r.label ?? ""
            let key = isMain ? "\u{0}main" : label
            if by[key] == nil { by[key] = DuckGroup(label: label, isMain: isMain, rows: []); order.append(key) }
            by[key]?.rows.append(r)
        }
        return order.compactMap { by[$0] }.enumerated().sorted { a, b in
            switch (a.element.lastActivityAt, b.element.lastActivityAt) {
            case let (x?, y?) where x != y: return x > y
            case (nil, .some): return false
            case (.some, nil): return true
            default: return a.offset < b.offset
            }
        }.map(\.element)
    }

    /// The pond page's "Branches": each branch with how many ducks work on it (main included when a duck is there).
    public static func branches(_ rows: [DuckRow]) -> [DuckBranch] {
        groups(rows).filter { $0.isMain || !$0.label.isEmpty }
            .map { DuckBranch(label: $0.label, isMain: $0.isMain, duckCount: $0.rows.count, lastActivityAt: $0.lastActivityAt, lead: $0.rows.first?.session) }
    }

    /// "Work with…": the other ducks (by their chat's title) and then each branch they sit on, never the duck itself, and
    /// never main (a duck on main is read-only; use "Move to main" for that).
    public static func joinTargets(_ rows: [DuckRow], excluding: SessionKey?) -> [DuckJoinTarget] {
        let others = rows.filter { $0.id != excluding && !$0.isMain && $0.branch != nil && $0.session.duckId != nil }
        let ownBranch = rows.first { $0.id == excluding }?.branch
        var out = others.map { r in
            DuckJoinTarget(title: r.session.title.isEmpty ? "Duck" : r.session.title, branch: r.branch ?? "", kind: .duck(r.session.duckId ?? ""))
        }
        var seen = Set<String>()
        for r in rows where !r.isMain {
            guard let b = r.branch, b != ownBranch, seen.insert(b).inserted else { continue }
            out.append(DuckJoinTarget(title: b, branch: b, kind: .branch(b)))
        }
        return out
    }
}

/// The header for a duck: its branch chip and whether Create PR shows. Pure; `PondChrome` still hides all of it on a
/// remote pond.
public struct DuckHeaderChrome: Equatable, Sendable {
    public var chip: String?
    public var readOnly: Bool
    public var showsCreatePR: Bool

    public static func of(branch: String?, isMain: Bool, membership: PondMembership) -> DuckHeaderChrome {
        guard membership.showsCode else { return DuckHeaderChrome(chip: nil, readOnly: false, showsCreatePR: false) }
        if isMain { return DuckHeaderChrome(chip: "\(DuckRow.mainLabel) \u{00B7} read-only", readOnly: true, showsCreatePR: false) }
        guard let b = branch, !b.isEmpty else { return DuckHeaderChrome(chip: nil, readOnly: false, showsCreatePR: false) }
        return DuckHeaderChrome(chip: b, readOnly: false, showsCreatePR: true)
    }
}

/// The tab strip in ducks mode: the pond's ducks, in the saved order, the open chat always among them.
public enum DuckTabPlan {
    public static func plan(location: WorkbenchLocation, previous: String?, ducks: [DuckRow]) -> StripPlan {
        StripPlan.plan(location: location, previous: previous, threads: ducks.map { $0.session.key.stringValue })
    }
}

/// "Group by branch" in the sidebar, remembered per pond (a JSON list of pond keys in one preference string).
public enum DuckGroupPrefs {
    public static func ponds(_ raw: String) -> Set<String> {
        guard let d = raw.data(using: .utf8), let list = try? JSONDecoder().decode([String].self, from: d) else { return [] }
        return Set(list)
    }
    public static func contains(_ raw: String, pond: String) -> Bool { ponds(raw).contains(pond) }
    /// The preference string after turning grouping on or off for `pond`.
    public static func toggled(_ raw: String, pond: String) -> String {
        var set = ponds(raw)
        if !set.insert(pond).inserted { set.remove(pond) }
        let data = (try? JSONEncoder().encode(set.sorted())) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
