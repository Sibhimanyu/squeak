import Foundation

/// One project card on Home: the active chats of a repo (or folder), newest first.
public struct HomeProject: Equatable, Sendable, Identifiable {
    public var name: String
    public var sessions: [HostSession]
    public var id: String { name }
    public var lastActivityAt: Date? { sessions.compactMap(\.lastActivityAt).max() }
    public var workingCount: Int { sessions.filter { $0.state == .working && $0.alive != false }.count }
    public var needsYouCount: Int { sessions.filter { $0.state == .blocked && $0.alive != false }.count }
}

/// Home's projects, as the iPhone lists them. Urgency lives in Needs you, never in sort order:
/// projects by their newest chat, chats newest first inside, ties by title.
public enum HomeProjects {
    public static let otherName = "Other"

    /// The project a chat belongs to: its repo, else the folder it runs in, else "Other".
    public static func projectName(_ s: HostSession) -> String {
        if let r = s.repoName, !r.isEmpty { return r }
        if let c = s.cwd, !c.isEmpty {
            let last = (c as NSString).lastPathComponent
            if !last.isEmpty, last != "/" { return last }
        }
        return otherName
    }

    /// Newest first; a chat with no time last; ties by title, then key, so the order is stable.
    public static func before(_ x: HostSession, _ y: HostSession) -> Bool {
        switch (x.lastActivityAt, y.lastActivityAt) {
        case let (a?, b?) where a != b: return a > b
        case (nil, .some): return false
        case (.some, nil): return true
        default:
            let tx = x.title.lowercased(), ty = y.title.lowercased()
            if tx != ty { return tx < ty }
            return x.key.stringValue < y.key.stringValue
        }
    }

    /// Chats idle for more than a day are not on Home's cards (search finds them under "Earlier").
    public static func build(_ sessions: [HostSession], now: Date = Date()) -> [HomeProject] {
        var buckets: [String: [HostSession]] = [:]
        for s in sessions where !SessionGrouping.isEarlier(s, now: now) {
            buckets[projectName(s), default: []].append(s)
        }
        let projects = buckets.map { HomeProject(name: $0.key, sessions: $0.value.sorted(by: before)) }
        return projects.sorted { a, b in
            switch (a.lastActivityAt, b.lastActivityAt) {
            case let (x?, y?) where x != y: return x > y
            case (nil, .some): return false
            case (.some, nil): return true
            default: return a.name.lowercased() < b.name.lowercased()
            }
        }
    }
}

/// Search on Home: chats that are active come first, then the earlier ones.
public enum HomeSearch {
    public struct Split: Equatable, Sendable {
        public var active: [SearchHit]
        public var earlier: [SearchHit]
    }

    public static func split(_ hits: [SearchHit], sessions: [HostSession], now: Date = Date()) -> Split {
        let byKey = Dictionary(sessions.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var active: [SearchHit] = [], earlier: [SearchHit] = []
        for h in hits {
            guard let s = byKey[h.key] else { continue }
            if SessionGrouping.isEarlier(s, now: now) { earlier.append(h) } else { active.append(h) }
        }
        return Split(active: active, earlier: earlier)
    }
}

/// The Mac status strip on Home: words drawn from `/state`, nothing decided here.
public enum MacStatusStrip {
    public enum Tone: Equatable, Sendable { case ok, quiet, warning }
    public struct Item: Equatable, Sendable, Identifiable {
        public var text: String
        public var tone: Tone
        public var id: String { text }
    }

    public static func items(awake: DaemonAwake?, power: DaemonPower?, connected: Bool,
                             locale: Locale = .current, timeZone: TimeZone = .current) -> [Item] {
        var out: [Item] = []
        if !connected { out.append(Item(text: "Offline", tone: .warning)) }
        if let awake {
            var t = "Awake " + AwakeFormat.headline(awake, locale: locale, timeZone: timeZone).replacingOccurrences(of: "On ", with: "")
            if awake.lid { t += " · lid closed" }
            out.append(Item(text: t, tone: .ok))
        }
        if let power, let mode = power.mode, mode != "auto" {
            out.append(Item(text: DaemonPower.title(mode), tone: .quiet))
        }
        return out
    }
}
