import Foundation
import SqueakCore

/// What the Mac says about a pond beyond its name (`ponds2`): all optional, so an older Mac reads as "nothing".
struct PondMeta: Equatable, Sendable {
    var hidden = false
    var colour: String?
    var labels: [String] = []
    var lastActivityAt: String?
    /// nil = the Mac sent no streams; they are then derived from the chats' workspaces.
    var streams: [StreamMeta]?
    var archivedStreams = 0
}

struct StreamMeta: Equatable, Sendable, Identifiable {
    let id: String
    var name: String
    var branch: String?
    var pinned = false
    var archived = false
    var lastActivityAt: String?
}

/// One pond on the Ponds tab: the Mac's pond (or, from an older Mac, a repo) with the chats in it.
struct PondItem: Equatable, Identifiable {
    let id: String
    let name: String
    let pond: PhoneSnapshot.Pond?
    let sessions: [PhoneSnapshot.Session]
    let meta: PondMeta

    /// What the Mac's order lists (`projectId ?? id`).
    var orderKey: String { pond?.orderKey ?? id }
    var hidden: Bool { meta.hidden }
    var shared: Bool { pond?.shared == true }
    var needsYou: Int { Presentation.needsYouCount(sessions) }
    var working: Int { sessions.filter { $0.state == "working" && !$0.needsYou }.count }
    var online: Int { pond?.members.filter(\.online).count ?? 0 }
    /// The newest of the Mac's stamp and the chats'.
    var lastActivity: Date? {
        ([PondList.date(meta.lastActivityAt)] + sessions.map { Age.date($0.lastActivityAt) }).compactMap { $0 }.max()
    }
    /// A pond made up from a chat's repo name because the Mac sent no pond for it.
    var isSynthetic: Bool { id.hasPrefix(PondList.namePrefix) }
}

struct StreamItem: Equatable, Identifiable {
    let id: String
    let name: String
    let branch: String?
    let pinned: Bool
    let sessions: [PhoneSnapshot.Session]
    let lastActivity: Date?
}

enum PondScope: String, Hashable, CaseIterable {
    case all, needsYou, working, shared

    var title: String {
        switch self {
        case .all: "All threads"
        case .needsYou: "Needs you"
        case .working: "Working"
        case .shared: "Shared"
        }
    }
}

enum PondOrderMode: Equatable, Sendable {
    case newest
    case manual([String])
}

enum PondList {
    static let namePrefix = "name:"

    static func threadCount(_ count: Int) -> String { count == 1 ? "1 thread" : "\(count) threads" }

    static func date(_ iso: String?) -> Date? { iso.flatMap(Age.date) }

    struct Built: Equatable {
        var ponds: [PondItem] = []
        /// Chats the Mac put in no pond (a terminal in the home folder): one folded "Other" group, never pond rows.
        var other: [PhoneSnapshot.Session] = []
        func item(_ id: String) -> PondItem? { ponds.first { $0.id == id } }
    }

    /// The ponds with their chats. From a Mac that sent no ponds every repo is a stand-in pond and nothing is "Other".
    static func build(sessions: [PhoneSnapshot.Session], ponds: [PhoneSnapshot.Pond]) -> Built {
        if ponds.isEmpty {
            let projects = Presentation.projects(sessions)
            return Built(ponds: projects.map {
                PondItem(id: namePrefix + $0.name, name: $0.name, pond: nil, sessions: $0.sessions, meta: PondMeta())
            }, other: [])
        }
        var byPond: [String: [PhoneSnapshot.Session]] = [:]
        var strays: [PhoneSnapshot.Session] = []
        var unknown: [String: PhoneSnapshot.PondRef] = [:]
        let known = Set(ponds.map(\.id))
        for session in sessions {
            if let ref = session.pond {
                byPond[ref.id, default: []].append(session)
                if !known.contains(ref.id) { unknown[ref.id] = ref }
            } else {
                strays.append(session)
            }
        }
        var items = ponds.map {
            PondItem(id: $0.id, name: $0.name, pond: $0, sessions: Presentation.newestFirst(byPond[$0.id] ?? []), meta: $0.meta)
        }
        for (id, ref) in unknown {
            items.append(PondItem(id: id, name: ref.name, pond: nil, sessions: Presentation.newestFirst(byPond[id] ?? []), meta: PondMeta()))
        }
        return Built(ponds: items, other: Presentation.newestFirst(strays))
    }

    /// Newest first, or the person's own order. In their order a pond they have not placed yet (a new one) sits on top,
    /// newest first, and the rest follow their saved order.
    static func ordered(_ items: [PondItem], mode: PondOrderMode) -> [PondItem] {
        let newest: ([PondItem]) -> [PondItem] = { list in
            list.sorted {
                switch ($0.lastActivity, $1.lastActivity) {
                case let (a?, b?) where a != b: return a > b
                case (.some, nil): return true
                case (nil, .some): return false
                default: return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                }
            }
        }
        switch mode {
        case .newest: return newest(items)
        case .manual(let ids):
            let position = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
            let placed = items.filter { position[$0.orderKey] != nil }.sorted { position[$0.orderKey]! < position[$1.orderKey]! }
            return newest(items.filter { position[$0.orderKey] == nil }) + placed
        }
    }

    struct Shown: Equatable {
        var items: [PondItem]
        /// Ponds left out because they are hidden (for the "N hidden" footer).
        var hiddenCount: Int
    }

    /// The "Other" threads a search leaves: those whose title or stream name matches every term.
    static func otherMatching(_ sessions: [PhoneSnapshot.Session], query: String) -> [PhoneSnapshot.Session] {
        let terms = SmartSearch.fold(query).split(separator: " ").map(String.init)
        guard !terms.isEmpty else { return sessions }
        return sessions.filter { session in
            let haystack = SmartSearch.fold([Presentation.displayTitle(session), Presentation.workspaceName(session)].joined(separator: " "))
            return terms.allSatisfy { haystack.contains($0) }
        }
    }

    /// Hidden ones leave unless asked for; a label narrows; a query matches the pond's name, labels, streams and threads.
    static func visible(_ items: [PondItem], showHidden: Bool, label: String? = nil, query: String = "") -> Shown {
        var out = items
        if let label { out = out.filter { $0.meta.labels.contains(label) } }
        let terms = SmartSearch.fold(query).split(separator: " ").map(String.init)
        if !terms.isEmpty { out = out.filter { matches($0, terms: terms) } }
        let hiddenCount = out.filter(\.hidden).count
        if !showHidden { out = out.filter { !$0.hidden } }
        return Shown(items: out, hiddenCount: showHidden ? 0 : hiddenCount)
    }

    static func matches(_ item: PondItem, terms: [String]) -> Bool {
        let haystack = SmartSearch.fold(
            ([item.name] + item.meta.labels + (item.meta.streams ?? []).map(\.name)
                + item.sessions.flatMap { [Presentation.displayTitle($0), Presentation.workspaceName($0)] }).joined(separator: " "))
        return terms.allSatisfy { haystack.contains($0) }
    }

    /// Every label on any pond, sorted.
    static func labels(_ items: [PondItem]) -> [String] {
        Array(Set(items.flatMap(\.meta.labels))).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// The full order after moving rows inside the list shown (which may leave hidden or filtered ponds out): the shown
    /// ponds take the moved order in the positions they held, everything else stays where it was.
    static func reordered(full: [String], visible: [String], moving: IndexSet, to: Int) -> [String] {
        var moved = visible
        moved.move(fromOffsets: moving, toOffset: to)
        let shown = Set(visible)
        var next = moved.makeIterator()
        return full.map { shown.contains($0) ? (next.next() ?? $0) : $0 }
    }

    /* ---------- streams ---------- */

    static func streams(_ item: PondItem) -> (live: [StreamItem], archived: Int) {
        func belongs(_ s: PhoneSnapshot.Session, _ stream: StreamMeta) -> Bool {
            if let id = s.workspaceId, id == stream.id { return true }
            let name = Presentation.workspaceName(s)
            return !name.isEmpty && (name == stream.name || name == stream.branch)
        }
        guard let meta = item.meta.streams else {
            var groups: [String: [PhoneSnapshot.Session]] = [:]
            var names: [String: String] = [:]
            for s in item.sessions {
                let name = Presentation.workspaceName(s)
                guard !name.isEmpty else { continue }
                let key = s.workspaceId ?? name
                groups[key, default: []].append(s)
                names[key] = name
            }
            let live = groups.map { key, list -> StreamItem in
                let chats = Presentation.newestFirst(list)
                return StreamItem(id: key, name: names[key] ?? key, branch: nil, pinned: false, sessions: chats,
                                  lastActivity: chats.compactMap { Age.date($0.lastActivityAt) }.max())
            }
            return (sortStreams(live), 0)
        }
        let live = meta.filter { !$0.archived }.map { stream -> StreamItem in
            let chats = Presentation.newestFirst(item.sessions.filter { belongs($0, stream) })
            let newest = ([date(stream.lastActivityAt)] + chats.map { Age.date($0.lastActivityAt) }).compactMap { $0 }.max()
            return StreamItem(id: stream.id, name: stream.name, branch: stream.branch, pinned: stream.pinned, sessions: chats, lastActivity: newest)
        }
        let archived = max(item.meta.archivedStreams, meta.filter(\.archived).count)
        return (sortStreams(live), archived)
    }

    /// The archived streams the Mac listed (it counts the rest).
    static func archivedStreams(_ item: PondItem) -> [StreamItem] {
        let meta = (item.meta.streams ?? []).filter(\.archived)
        return sortStreams(meta.map { stream in
            let chats = Presentation.newestFirst(item.sessions.filter {
                $0.workspaceId == stream.id || (!Presentation.workspaceName($0).isEmpty && Presentation.workspaceName($0) == stream.name)
            })
            return StreamItem(id: stream.id, name: stream.name, branch: stream.branch, pinned: false, sessions: chats,
                              lastActivity: ([date(stream.lastActivityAt)] + chats.map { Age.date($0.lastActivityAt) }).compactMap { $0 }.max())
        })
    }

    static func sortStreams(_ streams: [StreamItem]) -> [StreamItem] {
        streams.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            switch ($0.lastActivity, $1.lastActivity) {
            case let (a?, b?) where a != b: return a > b
            case (.some, nil): return true
            case (nil, .some): return false
            default: return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        }
    }

    static func sessions(_ item: PondItem, scope: PondScope) -> [PhoneSnapshot.Session] {
        switch scope {
        case .all: item.sessions
        case .needsYou: item.sessions.filter(\.needsYou)
        case .working: item.sessions.filter { Presentation.inFilter($0, .working) }
        case .shared: item.shared ? item.sessions : []
        }
    }

    /* ---------- the Inbox's lanes ---------- */

    enum Lane: String, CaseIterable, Identifiable {
        case needsYou, working, done, idle
        var id: String { rawValue }
        var title: String {
            switch self {
            case .needsYou: "Needs you"
            case .working: "In progress"
            case .done: "Done"
            case .idle: "Idle"
            }
        }
    }

    static func lane(_ s: PhoneSnapshot.Session) -> Lane {
        if s.needsYou { return .needsYou }
        if s.state == "working" { return .working }
        if s.state == "finished" || s.state == "error" { return .done }
        return .idle
    }

    /// Needs you first, then In progress, Done, Idle; empty lanes left out; each newest first.
    static func lanes(_ sessions: [PhoneSnapshot.Session]) -> [(lane: Lane, sessions: [PhoneSnapshot.Session])] {
        Lane.allCases.compactMap { lane in
            let list = Presentation.newestFirst(sessions.filter { self.lane($0) == lane })
            return list.isEmpty ? nil : (lane, list)
        }
    }

    /* ---------- search ---------- */

    static func matchingPonds(_ items: [PondItem], query: String) -> [PondItem] {
        let terms = SmartSearch.fold(query).split(separator: " ").map(String.init)
        guard !terms.isEmpty else { return [] }
        return items.filter { item in
            let name = SmartSearch.fold(item.name)
            return terms.allSatisfy { name.contains($0) }
        }
    }

    static func matchingStreams(_ items: [PondItem], query: String) -> [(pond: PondItem, stream: StreamItem)] {
        let terms = SmartSearch.fold(query).split(separator: " ").map(String.init)
        guard !terms.isEmpty else { return [] }
        return items.flatMap { item in
            streams(item).live.filter { stream in
                let name = SmartSearch.fold(stream.name + " " + (stream.branch ?? ""))
                return terms.allSatisfy { name.contains($0) }
            }.map { (item, $0) }
        }
    }

    /// Recent searches, newest first, no repeats, at most 8.
    static func remembering(_ query: String, in recent: [String]) -> [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return recent }
        return Array(([q] + recent.filter { SmartSearch.fold($0) != SmartSearch.fold(q) }).prefix(8))
    }
}

extension PondList {
    /// A pond's colour as the Mac stores it: "#RRGGBB" / "RRGGBB", or a plain colour name. Anything else is no colour.
    static func colourHex(_ text: String?) -> UInt32? {
        guard var t = text?.trimmingCharacters(in: .whitespaces).lowercased(), !t.isEmpty else { return nil }
        let names: [String: UInt32] = [
            "red": 0xEF4444, "orange": 0xF97316, "amber": 0xF59E0B, "yellow": 0xEAB308, "green": 0x22C55E, "teal": 0x14B8A6,
            "cyan": 0x06B6D4, "blue": 0x3B82F6, "indigo": 0x6366F1, "purple": 0xA855F7, "violet": 0x8B5CF6, "pink": 0xEC4899,
            "gray": 0x71717A, "grey": 0x71717A,
        ]
        if let named = names[t] { return named }
        if t.hasPrefix("#") { t.removeFirst() }
        guard t.count == 6, let value = UInt32(t, radix: 16) else { return nil }
        return value
    }
}

extension PhoneSnapshot.Pond {
    /// What the Mac added in `ponds2`; empty from a Mac that did not.
    var meta: PondMeta {
        PondMeta(hidden: isHidden, colour: colour, labels: labels ?? [], lastActivityAt: lastActivityAt,
                 streams: streams?.map { StreamMeta(id: $0.id, name: $0.name, branch: $0.branch, pinned: $0.pinned == true, archived: $0.archived == true, lastActivityAt: $0.lastActivityAt) },
                 archivedStreams: archivedStreams ?? 0)
    }
}

extension Age {
    /// "now", "2m", "3h", "2d" for a date.
    static func describe(_ date: Date, now: Date = Date()) -> String {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h" : "\(hours / 24)d"
    }
}
