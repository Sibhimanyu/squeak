import Foundation

// DESIGN.md §8.10, Pond home: the project's workspaces, the chats in each and who is in each chat. Decided here,
// where CI can test it; the view only draws.

/// One person in a chat row's avatar stack.
public struct PondChatPerson: Sendable, Equatable, Identifiable {
    public enum Live: Sendable, Equatable { case none, viewing, typing }
    public var id: String
    public var name: String
    public var you: Bool
    /// Looking at this chat now or typing in it (the live ring).
    public var live: Live
    public var lastAt: Date?
}

/// A chat in a workspace card: this Mac's own, or another Mac's thread that lands there.
public struct PondChatRow: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var agent: String?
    public var state: PondThreadState
    /// This Mac's chat mark (the sidebar's); nil for another Mac's thread, which shows `state`.
    public var mark: ChatMark?
    public var lastAt: Date?
    /// The chat this Mac runs: clicking opens it.
    public var local: SessionKey?
    /// The thread in the pond, when shared; clicking a remote one opens the thread view.
    public var pondThread: String?
    public var shared: Bool { pondThread != nil }
    /// The starter's reported machine; absence must not invent a remote host.
    public var nest: String? = nil
    /// Background helpers still running in this Mac's chat (the sidebar row's duckling). Another Mac's thread carries none:
    /// the pond data does not say, so it stays 0 rather than invented.
    public var ducklingsRunning: Int = 0
    public var hostingLabel: String {
        if local != nil { return "This Mac" }
        if let nest, !nest.isEmpty { return nest }
        return "From the flock"
    }
    /// You first, then the others newest first; an unshared chat is you alone.
    public var people: [PondChatPerson]
}

public struct PondWorkspaceCard: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// The stream's readable title; `name` stays the folder slug (threads match on it).
    public var title: String? = nil
    /// What the card shows.
    public var displayTitle: String { StreamName.resolve(title: title, name: name, branch: nil, repo: nil) }
    /// The branch, unless it only repeats the name.
    public var branch: String?
    public var mark: FoldedMark?
    /// Newest first, ties by title.
    public var chats: [PondChatRow]
    /// Set on a branch with no threads yet: its card offers "New thread" in it.
    public var empty: NativeWorkspace?
    /// Newest chat; a branch with no threads sorts by when it was made.
    public var lastAt: Date? { chats.compactMap(\.lastAt).max() ?? empty?.createdAt }
}

public struct PondHomeLayout: Sendable, Equatable {
    public var workspaces: [PondWorkspaceCard]
    /// Threads from other Macs that name no workspace or branch this Mac has.
    public var fromFlock: [PondChatRow]
    /// How many chats each person is in, by member id.
    public var chatCounts: [String: Int]

    public var isEmpty: Bool { workspaces.isEmpty && fromFlock.isEmpty }
    /// Every thread the page shows: this Mac's chats in its workspaces plus other Macs' threads (a shared chat of this Mac is
    /// one row, never counted twice), so the header's "N threads" matches the page.
    public var threadCount: Int { workspaces.reduce(fromFlock.count) { $0 + $1.chats.count } }
    public static let fromFlockTitle = "From the flock"

    /// The non-archived workspaces of a project that no chat sits in: what the sidebar lists under the chats' branches.
    public static func emptyBranches(_ workspaces: [NativeWorkspace], projectId: String?, chats: [HostSession]) -> [NativeWorkspace] {
        guard let projectId else { return [] }
        return workspaces.filter { w in w.projectId == projectId && w.state != "archived" && !chats.contains { $0.cwd == w.path } }
    }

    public static func build(
        project: SidebarProject?, detail: PondDetail?, me: String,
        emptyBranches: [NativeWorkspace] = [], hostIdFor: (HostSession) -> String?, titleFor: (HostSession) -> String = { $0.title }, markFor: (HostSession) -> ChatMark? = { _ in nil }
    ) -> PondHomeLayout {
        let threads = detail?.threads ?? []
        let members = detail?.members ?? []
        let presence = detail?.presence ?? []
        let meId = detail?.meMember?.id
        let myId = meId ?? "me"

        func people(_ t: PondThread) -> [PondChatPerson] {
            var list = t.participants.map { p in (id: p.memberId, name: p.name, at: p.lastAt) }
            if list.isEmpty, !t.starter.isEmpty { list = [(t.starter, t.starterName, t.updatedAt)] }
            return list.map { p in
                let name = p.name.isEmpty ? (members.first { $0.id == p.id }?.name ?? "") : p.name
                let entry = presence.first { $0.member == p.id && $0.online }
                let live: PondChatPerson.Live = entry?.typingIn == t.id ? .typing : (entry?.viewing == t.id ? .viewing : .none)
                return PondChatPerson(id: p.id, name: name, you: p.id == meId, live: live, lastAt: p.at)
            }
            .sorted {
                if $0.you != $1.you { return $0.you }
                let a = $0.lastAt ?? .distantPast, b = $1.lastAt ?? .distantPast
                return a != b ? a > b : $0.name.localizedCompare($1.name) == .orderedAscending
            }
        }
        func order(_ rows: [PondChatRow]) -> [PondChatRow] {
            rows.sorted {
                let a = $0.lastAt ?? .distantPast, b = $1.lastAt ?? .distantPast
                return a != b ? a > b : $0.title.localizedCompare($1.title) == .orderedAscending
            }
        }

        // A thread this Mac's person started and this Mac runs is that local chat.
        var hosted: [String: PondThread] = [:]
        for t in threads where t.starter == meId { if let s = t.sessionId { hosted[s] = t } }
        var used = Set<String>()
        let you = PondChatPerson(id: myId, name: me, you: true, live: .none, lastAt: nil)

        var cards = (project?.workspaces ?? []).map { ws -> PondWorkspaceCard in
            let rows = ws.chats.map { s -> PondChatRow in
                let thread = hostIdFor(s).flatMap { hosted[$0] }
                if let thread { used.insert(thread.id) }
                return PondChatRow(
                    id: s.key.stringValue, title: titleFor(s), agent: s.agent, state: PondThreadState(s.state), mark: markFor(s),
                    lastAt: s.lastActivityAt, local: s.key, pondThread: thread?.id, nest: thread?.nest, ducklingsRunning: s.ducklings?.running ?? 0, people: thread.map(people) ?? [you])
            }
            return PondWorkspaceCard(id: ws.id, name: ws.name, title: ws.title, branch: ws.branchLabel, mark: ws.foldedMark, chats: rows)
        }
        // Every other non-archived branch of the pond, as the sidebar lists them: no thread yet.
        for w in emptyBranches {
            let label = SidebarWorkspace.branchLabel(branch: w.branch, name: w.name)
            cards.append(PondWorkspaceCard(id: w.projectId + "/" + w.id, name: w.name, title: w.title, branch: label, mark: nil, chats: [], empty: w))
        }
        let branches = cards.indices.reduce(into: [String: Int]()) { d, i in
            let own = project?.workspaces.count ?? 0
            let b = i < own ? project?.workspaces[i].branch : cards[i].empty?.branch
            if let b, !b.isEmpty, d[b] == nil { d[b] = i }
        }
        let names = cards.indices.reduce(into: [String: Int]()) { d, i in
            let k = cards[i].name.lowercased()
            if d[k] == nil { d[k] = i }
        }

        var flock: [PondChatRow] = []
        for t in threads where !used.contains(t.id) {
            let row = PondChatRow(
                id: "thread:" + t.id, title: t.title.isEmpty ? "Untitled thread" : t.title, agent: t.agent, state: PondThreadState(raw: t.state),
                mark: nil, lastAt: t.updatedAt, local: nil, pondThread: t.id, nest: t.nest, people: people(t))
            if let b = t.branch, !b.isEmpty, let i = branches[b] {
                cards[i].chats.append(row)
            } else if let w = t.workspace?.lowercased(), !w.isEmpty, let i = names[w] {
                cards[i].chats.append(row)
            } else {
                flock.append(row)
            }
        }
        cards = cards.map { var c = $0; c.chats = order(c.chats); if !c.chats.isEmpty { c.empty = nil }; return c }
        cards.sort {
            switch ($0.lastAt, $1.lastAt) {
            case let (x?, y?) where x != y: return x > y
            case (nil, .some): return false
            case (.some, nil): return true
            default: return $0.displayTitle.localizedCompare($1.displayTitle) == .orderedAscending
            }
        }
        let all = cards.flatMap(\.chats) + flock
        var counts: [String: Int] = [:]
        for r in all { for p in r.people { counts[p.id, default: 0] += 1 } }
        return PondHomeLayout(workspaces: cards, fromFlock: order(flock), chatCounts: counts)
    }
}

/// A dashboard scope always filters the same deduplicated rows that the branch list displays.
public enum PondDashboardScope: String, CaseIterable, Sendable {
    case all, needsYou, working, shared

    public var title: String {
        switch self {
        case .all: "All threads"
        case .needsYou: "Needs you"
        case .working: "Working"
        case .shared: "Shared"
        }
    }

    public func includes(_ row: PondChatRow) -> Bool {
        switch self {
        case .all: true
        case .needsYou: row.state == .needsYou
        case .working: row.state == .working || row.ducklingsRunning > 0
        case .shared: row.shared
        }
    }
}

extension PondHomeLayout {
    public var threads: [PondChatRow] { workspaces.flatMap(\.chats) + fromFlock }

    public func count(in scope: PondDashboardScope) -> Int { threads.filter(scope.includes).count }

    /// A matching branch exposes its threads; a matching person, title or provider exposes that row only.
    /// Empty branches remain discoverable in All, including when searching for their name.
    public func filtered(query: String, scope: PondDashboardScope) -> PondHomeLayout {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        func matches(_ text: String) -> Bool { words.allSatisfy { text.localizedStandardContains($0) } }
        func includes(_ row: PondChatRow, branch: String = "") -> Bool {
            scope.includes(row) && matches(([branch, row.title, row.agent ?? ""] + row.people.map(\.name)).joined(separator: " "))
        }
        let cards = workspaces.compactMap { card -> PondWorkspaceCard? in
            var copy = card
            let branch = card.name + " " + (SidebarTreeBuilder.clean(card.title) ?? "") + " " + (card.branch ?? "")
            copy.chats = card.chats.filter { includes($0, branch: branch) }
            guard !copy.chats.isEmpty || (card.chats.isEmpty && scope == .all && matches(branch)) else { return nil }
            return copy
        }
        return PondHomeLayout(workspaces: cards, fromFlock: fromFlock.filter { includes($0) }, chatCounts: chatCounts)
    }
}
