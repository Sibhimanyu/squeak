import Foundation

// DESIGN.md "Pond tab, dashboard and Thread tab": the Pond tab is a compact, live glance at the pond of the thread on
// screen (people, what is going on, what just happened); the pond dashboard is where a pond is managed. Everything the
// tab says is decided here so CI can test it; the view only draws.

public struct PondGlance: Equatable, Sendable {
    public struct Person: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var initial: String
        public var colourIndex: Int
        public var you: Bool
        public var online: Bool
        /// Titles of the threads this person has working right now.
        public var working: [String]
        public var needsYou: Int
        /// "Working on Fix login", "2 threads working", "Online", "Last seen 3 h ago"; never empty.
        public var line: String
    }

    public struct NowRow: Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        /// "You" for your own, else the starter's name.
        public var owner: String
        public var state: PondThreadState
        /// A chat on this Mac: opens in the centre.
        public var localKey: SessionKey?
        /// A thread the pond holds (opened from the pond's route); nil for a Mac-only thread.
        public var threadId: String?
    }

    public var people: [Person]
    public var now: [NowRow]
    public var recent: [PondRipple]

    public static let recentCap = 6
    public static let nowCap = 8

    public var isEmpty: Bool { people.isEmpty && now.isEmpty && recent.isEmpty }

    /// `detail` is the shared pond's record (nil for a pond that is only on this Mac); `local` are this Mac's chats in
    /// the pond. A chat the pond already lists (same session id) is read from the pond, never twice.
    public static func build(
        detail: PondDetail?, local: [PondThreadFact], youName: String, now date: Date = Date()
    ) -> PondGlance {
        let me = detail?.meMember?.id
        let listed = Set((detail?.threads ?? []).compactMap(\.sessionId))
        let localOnly = local.filter { !listed.contains(PondOpenResolver.hostId(of: $0.key)) }
        let localByHostId = Dictionary(local.map { (PondOpenResolver.hostId(of: $0.key), $0.key) }, uniquingKeysWith: { a, _ in a })

        // Now: needing someone first, then working; newest first inside each.
        var rows: [(row: NowRow, at: Date)] = []
        for t in detail?.threads ?? [] {
            let state = PondThreadState(raw: t.state)
            guard state == .needsYou || state == .working else { continue }
            let key = t.sessionId.flatMap { localByHostId[$0] }
            let own = me.map { t.starter == $0 } ?? false
            rows.append((NowRow(id: "pond:\(t.id)", title: t.title.isEmpty ? "A duck" : t.title,
                                owner: own ? "You" : (t.starterName.isEmpty ? "Someone" : t.starterName),
                                state: state, localKey: key, threadId: t.id), t.updatedAt ?? .distantPast))
        }
        for f in localOnly {
            let state: PondThreadState = f.looping ? .needsYou : PondThreadState(f.state)
            guard state == .needsYou || state == .working else { continue }
            rows.append((NowRow(id: "local:\(f.key.hostSessionId)", title: f.title.isEmpty ? "A duck" : f.title, owner: "You",
                                state: state, localKey: f.key, threadId: nil), f.lastActivityAt ?? .distantPast))
        }
        rows.sort {
            let a = $0.row.state == .needsYou ? 0 : 1, b = $1.row.state == .needsYou ? 0 : 1
            if a != b { return a < b }
            return $0.at != $1.at ? $0.at > $1.at : $0.row.id < $1.row.id
        }
        let nowRows = rows.prefix(nowCap).map(\.row)

        // People.
        var people: [Person] = []
        if let detail {
            for m in detail.members {
                let mine = rows.map(\.row).filter { r in
                    guard r.threadId != nil, let t = detail.threads.first(where: { "pond:\($0.id)" == r.id }) else { return false }
                    return t.starter == m.id
                }
                var working = mine.filter { $0.state == .working }.map(\.title)
                var needs = mine.filter { $0.state == .needsYou }.count
                if m.you {
                    for r in rows.map(\.row) where r.id.hasPrefix("local:") {
                        if r.state == .working { working.append(r.title) } else { needs += 1 }
                    }
                }
                let online = PondFlock.isOnline(m, presence: detail.presence)
                people.append(Person(
                    id: m.id, name: m.name.isEmpty ? "Someone" : m.name, initial: m.initial, colourIndex: m.colourIndex, you: m.you,
                    online: online, working: working, needsYou: needs,
                    line: personLine(working: working, needsYou: needs, online: online, lastSeen: m.lastSeenAt, now: date)))
            }
        } else {
            let working = localOnly.filter { !$0.looping && PondThreadState($0.state) == .working }.map(\.title)
            let needs = localOnly.filter { $0.looping || PondThreadState($0.state) == .needsYou }.count
            let name = youName.trimmingCharacters(in: .whitespaces).isEmpty ? "You" : youName
            people.append(Person(
                id: "person:local", name: name, initial: String(name.first.map { String($0).uppercased() } ?? "Y"),
                colourIndex: PondPresence.colourIndex(for: name), you: true, online: true, working: working, needsYou: needs,
                line: personLine(working: working, needsYou: needs, online: true, lastSeen: nil, now: date)))
        }
        // Most active first: more working threads, then more waiting, then online, then you, then name.
        people.sort {
            if $0.working.count != $1.working.count { return $0.working.count > $1.working.count }
            if $0.needsYou != $1.needsYou { return $0.needsYou > $1.needsYou }
            if $0.online != $1.online { return $0.online }
            if $0.you != $1.you { return $0.you }
            return $0.name.localizedCompare($1.name) == .orderedAscending
        }

        // Recent: the pond's own ripples plus this Mac's chats the pond does not list; newest first.
        let remote = PondRippleFeed.build(detail?.ripples ?? [], me: me, cap: 20)
        let mineOnly = PondRipples.build(threads: localOnly, cap: 20)
        let recent = (remote + mineOnly).sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }.prefix(recentCap)
        return PondGlance(people: people, now: Array(nowRows), recent: Array(recent))
    }

    static func personLine(working: [String], needsYou: Int, online: Bool, lastSeen: Date?, now: Date) -> String {
        if working.count == 1 { return "Working on \(working[0])" }
        if working.count > 1 { return "\(working.count) ducks working" }
        if needsYou > 0 { return needsYou == 1 ? "1 duck needs them" : "\(needsYou) ducks need them" }
        if online { return "Online" }
        if let lastSeen { return "Last seen \(PondMembers.ago(lastSeen, now: now))" }
        return "Away"
    }
}
