import Foundation

/// Ducks own their branch (the Mac's `ducksOwnBranch` flag, `PhoneSnapshot.ducksOwnBranch`): a pond holds ducks, and each
/// duck works on a branch (or reads Main). Everything here is pure: the Mac computes `duckId`, `branch` and `onMain`
/// and the phone only groups, orders and words them. With the flag off none of it is used and the stream UI is as before.
public enum DuckPhone {
    public static let mainLabel = "main"

    /// Whether the phone shows ducks by branch at all: the Mac says so, and only then.
    public static func enabled(_ snapshot: PhoneSnapshot?) -> Bool { snapshot?.ducksOwnBranch == true }

    public static func isMain(_ s: PhoneSnapshot.Session) -> Bool { s.onMain == true }

    /// The branch the chat works on; nil on main, on a detached HEAD or when the Mac did not say.
    public static func branch(_ s: PhoneSnapshot.Session) -> String? {
        guard !isMain(s), let b = s.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty, b != "HEAD" else { return nil }
        return b
    }

    /// The small mono label on a row: "main" or the branch. Nil when the pond shows no code (a remote pond) or it is unknown.
    public static func label(_ s: PhoneSnapshot.Session, showsCode: Bool = true) -> String? {
        guard showsCode, s.duckId != nil || s.onMain == true || s.branch != nil else { return nil }
        return isMain(s) ? mainLabel : branch(s)
    }

    /// One duck as a list shows it: its newest chat.
    public struct Row: Equatable, Identifiable, Sendable {
        public var session: PhoneSnapshot.Session
        public var label: String?
        public var isMain: Bool
        public var id: String { session.key }
    }

    public struct Group: Equatable, Identifiable, Sendable {
        public var label: String
        public var isMain: Bool
        public var rows: [Row]
        public var id: String { isMain ? "\u{0}main" : label }
        public var newest: Date? { rows.compactMap { ISO8601DateFormatter.squeakParse($0.session.lastActivityAt) }.max() }
    }

    private static func date(_ s: PhoneSnapshot.Session) -> Date { ISO8601DateFormatter.squeakParse(s.lastActivityAt) ?? .distantPast }

    /// The pond's ducks, newest first (ties by key): a duck with several chats shows its newest, a chat with no duck
    /// (a terminal agent) is its own row.
    public static func rows(_ sessions: [PhoneSnapshot.Session], showsCode: Bool = true) -> [Row] {
        var newest: [String: PhoneSnapshot.Session] = [:]
        for s in sessions {
            let k = s.duckId ?? "chat:\(s.key)"
            if let have = newest[k], date(have) >= date(s) { continue }
            newest[k] = s
        }
        return newest.values
            .sorted { date($0) != date($1) ? date($0) > date($1) : $0.key < $1.key }
            .map { Row(session: $0, label: label($0, showsCode: showsCode), isMain: isMain($0)) }
    }

    /// "Group by branch": one group per branch, the one with the newest duck first, ducks newest first inside. Ducks whose
    /// branch is unknown go in a last group with no name.
    public static func groups(_ rows: [Row]) -> [Group] {
        var by: [String: Group] = [:]
        for r in rows {
            let key = r.isMain ? "\u{0}main" : (r.label ?? "\u{1}")
            by[key, default: Group(label: r.isMain ? mainLabel : (r.label ?? ""), isMain: r.isMain, rows: [])].rows.append(r)
        }
        return by.values.sorted { a, b in
            if a.label.isEmpty != b.label.isEmpty { return !a.label.isEmpty }
            switch (a.newest, b.newest) {
            case let (x?, y?) where x != y: return x > y
            default: return a.label < b.label
            }
        }
    }

    /// The chat header: the branch, or "main · read-only", and whether a pull request can be asked for. A remote pond
    /// shows none of it.
    public struct Header: Equatable, Sendable {
        public var chip: String?
        public var readOnly: Bool
        public var showsPullRequest: Bool
    }

    public static func header(_ s: PhoneSnapshot.Session, remote: Bool) -> Header {
        guard !remote else { return Header(chip: nil, readOnly: false, showsPullRequest: false) }
        if isMain(s) { return Header(chip: "\(mainLabel) \u{00B7} read-only", readOnly: true, showsPullRequest: false) }
        guard let b = branch(s) else { return Header(chip: nil, readOnly: false, showsPullRequest: true) }
        return Header(chip: b, readOnly: false, showsPullRequest: true)
    }

    /// The chat's own title, for a line of "Work with…".
    static func title(of s: PhoneSnapshot.Session) -> String {
        let t = (s.title ?? s.label).trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "Duck" : t
    }

    /// A line of "Work with…": another duck, or a branch.
    public struct JoinTarget: Equatable, Identifiable, Sendable {
        public var title: String
        public var branch: String
        public var duckId: String?
        public var id: String { duckId.map { "duck:\($0)" } ?? "branch:\(branch)" }
        public var place: DuckPlace { duckId.map { .join(duckId: $0) } ?? .join(branch: branch) }
    }

    /// What the duck's menu offers: Branch off, Work with…, Move to main. Nothing for a remote pond or a chat with no duck;
    /// nothing while the duck works (the host refuses a move then).
    public struct Moves: Equatable, Sendable {
        public var branchOff: Bool
        public var moveToMain: Bool
        public var joinTargets: [JoinTarget]
        public var any: Bool { branchOff || moveToMain || !joinTargets.isEmpty }
        public static let none = Moves(branchOff: false, moveToMain: false, joinTargets: [])
    }

    public static func moves(for s: PhoneSnapshot.Session, among rows: [Row], remote: Bool) -> Moves {
        guard !remote, s.duckId != nil, s.state != "working", s.state != "awaiting_approval" else { return .none }
        let own = branch(s)
        var targets: [JoinTarget] = rows.filter { !$0.isMain && $0.session.duckId != nil && $0.session.duckId != s.duckId && $0.label != nil }
            .map { JoinTarget(title: title(of: $0.session), branch: $0.label ?? "", duckId: $0.session.duckId) }
        var seen = Set<String>()
        for r in rows where !r.isMain {
            guard let b = r.label, b != own, seen.insert(b).inserted else { continue }
            targets.append(JoinTarget(title: b, branch: b, duckId: nil))
        }
        return Moves(branchOff: true, moveToMain: !isMain(s), joinTargets: targets)
    }
}

/// "Group by branch" on a pond page, remembered per pond (a JSON list of pond ids in one preference string).
public enum DuckGroupPrefs {
    public static func ponds(_ raw: String) -> Set<String> {
        guard let d = raw.data(using: .utf8), let list = try? JSONDecoder().decode([String].self, from: d) else { return [] }
        return Set(list)
    }
    public static func contains(_ raw: String, pond: String) -> Bool { ponds(raw).contains(pond) }
    public static func toggled(_ raw: String, pond: String) -> String {
        var set = ponds(raw)
        if !set.insert(pond).inserted { set.remove(pond) }
        let data = (try? JSONEncoder().encode(set.sorted())) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
