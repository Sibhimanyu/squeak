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
/// What an Off-duty Duck's Dashboard row says under its chat title.
public struct PondOffDutyNote: Sendable, Equatable {
    public var line: String
    public var summary: String?
    public init(line: String, summary: String? = nil) { self.line = line; self.summary = summary }

    /// From the host's duck list, by the chat's session id.
    public static func notes(_ ducks: [PondDuck], now: Date = Date()) -> [String: PondOffDutyNote] {
        var out: [String: PondOffDutyNote] = [:]
        for d in ducks where d.duty == .off {
            guard let sid = d.currentSessionId else { continue }
            out[sid] = PondOffDutyNote(line: RoomRoster.offDutyAgo(d.lastActiveAt, now: now), summary: d.lastSummary)
        }
        return out
    }
}

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
    /// A thread its starter keeps private: it says "Private", never "Shared".
    public var isPrivate: Bool = false
    /// A thread another member runs with their own agent on their own Mac (mode own, not this Mac's): marked as theirs.
    public var poweredBy: String? = nil
    public var visibility: String? { shared ? (isPrivate ? "Private" : (poweredBy ?? "Shared \u{00B7} \(hostingLabel)")) : nil }
    /// The starter's reported machine; absence must not invent a remote host.
    public var nest: String? = nil
    /// Background helpers still running in this Mac's chat (the sidebar row's duckling). Another Mac's thread carries none:
    /// the pond data does not say, so it stays 0 rather than invented.
    public var ducklingsRunning: Int = 0
    /// The duck is on duty (the host's roster says; a row it does not list is on duty).
    public var onDuty: Bool = true
    /// An Off-duty Duck's row: "off duty 3d ago" and its last summary line. Known by its title, never a name.
    public var offDuty: PondOffDutyNote? = nil
    /// This Mac's chat is repeating a failing step: its Needs you row offers "Tell it to stop retrying".
    public var isLooping: Bool = false
    /// The host's roster line for this Duck ("Working \u{00B7} 1 duckling on x", "Idle \u{00B7} 4m", "off duty 3d ago"), drawn as sent.
    public var statusLine: String? = nil
    /// The host's heading (name on duty, chat title off duty).
    public var heading: String? = nil
    /// The Duck's Stream chips ("Pond" when it is in none). Never a folder branch.
    public var streamLabels: [String] = []
    /// A thread of another Mac that matches no Duck of this Pond: shown under "From the flock", never counted toward duty.
    public var isFlock = false
    /// The Duck behind the row (the roster's id); nil for a flock thread.
    public var duckId: String? = nil
    /// "Repeating a failing step: <label> ×N" for that row.
    public var loopSentence: String? = nil
    public var hostingLabel: String {
        if local != nil { return "This Mac" }
        if let nest, !nest.isEmpty { return nest }
        return "From the flock"
    }
    /// You first, then the others newest first; an unshared chat is you alone.
    public var people: [PondChatPerson]
}

extension PondChatRow {
    func withPrivate(_ value: Bool) -> PondChatRow { var r = self; r.isPrivate = value; return r }
}

public struct PondWorkspaceCard: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// The stream's readable title; `name` stays the folder slug (threads match on it).
    public var title: String? = nil
    /// What the card shows.
    public var displayTitle: String { isMain ? (title ?? MainPlace.name) : StreamName.resolve(title: title, name: name, branch: nil, repo: nil) }
    /// The branch, unless it only repeats the name.
    public var branch: String?
    public var mark: FoldedMark?
    /// Newest first, ties by title.
    public var chats: [PondChatRow]
    /// Set on a branch with no threads yet: its card offers "New thread" in it.
    public var empty: NativeWorkspace?
    /// The pond's own folder: its card reads "Main", comes first, and has no stream menu.
    public var isMain = false
    /// Ducks mode: the pond's one list of ducks (no stream card: the page draws the rows without a card header).
    public var isDucks = false
    /// Main with no threads yet: the card offers "New thread" in it (`MainPlace`).
    public var emptyMain: MainPlace?
    /// Newest chat; a branch with no threads sorts by when it was made.
    public var lastAt: Date? { chats.compactMap(\.lastAt).max() ?? empty?.createdAt }
}

public struct PondHomeLayout: Sendable, Equatable {
    public var workspaces: [PondWorkspaceCard]
    /// Threads from other Macs that name no workspace or branch this Mac has.
    public var fromFlock: [PondChatRow]
    /// How many chats each person is in, by member id.
    public var chatCounts: [String: Int]
    /// The people in each cloud thread, by thread id (a roster row that matches a thread shows them).
    public var threadPeople: [String: [PondChatPerson]] = [:]

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

    /// Rows the Pond's Duck list holds: every roster Duck, not a flock thread.
    public var dutyCount: Int { threads.filter { !$0.isFlock }.count }

    /// The roster as the page draws it (the one list of a Pond's Ducks): one row per host Duck, in the host's order and with the
    /// host's words. This Mac's chat only supplies what a click opens; another Mac's thread joins the Duck whose chat it is, else
    /// waits in "From the flock" and never counts. Nothing of the daemon's /state rows is rebuilt here.
    public static func buildRoster(
        ducks: [PondDuck], sessions: [HostSession], detail: PondDetail?, me: String,
        hostIdFor: (HostSession) -> String?, hiddenThreads: Set<String> = [], ownThreads: Bool = true
    ) -> PondHomeLayout {
        let base = build(
            project: nil, detail: detail, me: me, hostIdFor: hostIdFor, hiddenThreads: hiddenThreads, ownThreads: ownThreads)
        let threads = detail?.threads ?? []
        let you = PondChatPerson(id: detail?.meMember?.id ?? "me", name: me, you: true, live: .none, lastAt: nil)
        var bySession: [String: HostSession] = [:]
        for s in sessions { if let id = hostIdFor(s) { bySession[id] = s } }
        var used = Set<String>()
        func peopleOf(_ t: PondThread) -> [PondChatPerson] {
            base.threadPeople[t.id] ?? [you]
        }
        let sorted = RoomRoster.roster(ducks).onDuty + RoomRoster.roster(ducks).offDuty
        let rows = sorted.map { d -> PondChatRow in
            let s = d.sessionId.flatMap { bySession[$0] }
            let thread = d.sessionId.flatMap { sid in threads.first { $0.sessionId == sid } }
            if let thread { used.insert(thread.id) }
            let state: PondThreadState
            switch d.activity {
            case .working: state = .working
            case .needsYou: state = .needsYou
            case .error: state = .failed
            case .idle: state = .finished
            }
            var row = PondChatRow(
                id: s?.key.stringValue ?? "duck:" + d.id, title: (d.chatTitle ?? "").isEmpty ? d.heading : d.chatTitle!, agent: s?.agent ?? d.agent, state: state,
                mark: nil, lastAt: d.lastActiveAt.map { Date(timeIntervalSince1970: Double($0) / 1000) }, local: s?.key,
                pondThread: thread?.id, nest: thread?.nestName ?? thread?.nest, ducklingsRunning: d.ducklingsRunning,
                isLooping: s?.isLoopingNow ?? false, loopSentence: s?.loopingSentence, people: thread.map(peopleOf) ?? [you])
                .withPrivate(thread?.isPrivate ?? false)
            row.onDuty = d.onDuty
            row.statusLine = d.presenceLine
            row.heading = d.heading
            row.streamLabels = d.streamLabels
            row.duckId = d.id
            if !d.onDuty { row.offDuty = PondOffDutyNote(line: d.presenceLine, summary: d.lastSummary) }
            return row
        }
        var flock: [PondChatRow] = []
        for t in threads where !used.contains(t.id) && !hiddenThreads.contains(t.id) {
            var row = PondChatRow(
                id: "thread:" + t.id, title: t.title.isEmpty ? "Untitled duck" : t.title, agent: t.agent, state: PondThreadState(raw: t.state),
                mark: nil, lastAt: t.updatedAt, local: nil, pondThread: t.id, nest: t.nestName ?? t.nest, people: peopleOf(t))
            if t.mode == .own { row.poweredBy = PondOwnThreads.poweredBy(nest: t.nestName ?? t.nest, ownThreads: ownThreads) }
            row.isFlock = true
            flock.append(row)
        }
        flock.sort {
            let a = $0.lastAt ?? .distantPast, b = $1.lastAt ?? .distantPast
            return a != b ? a > b : $0.title.localizedCompare($1.title) == .orderedAscending
        }
        var card = PondWorkspaceCard(id: "ducks", name: "Ducks", title: nil, branch: nil, mark: nil, chats: rows)
        card.isDucks = true
        var counts: [String: Int] = [:]
        for r in rows + flock { for p in r.people { counts[p.id, default: 0] += 1 } }
        return PondHomeLayout(workspaces: rows.isEmpty ? [] : [card], fromFlock: flock, chatCounts: counts, threadPeople: base.threadPeople)
    }

    public static func build(
        project: SidebarProject?, detail: PondDetail?, me: String,
        emptyBranches: [NativeWorkspace] = [], main: MainPlace? = nil, hostIdFor: (HostSession) -> String?, titleFor: (HostSession) -> String = { $0.title }, markFor: (HostSession) -> ChatMark? = { _ in nil },
        hiddenThreads: Set<String> = [], ownThreads: Bool = true, offDutySessions: Set<String> = [], offDutyNotes: [String: PondOffDutyNote] = [:]
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
                var made = PondChatRow(
                    id: s.key.stringValue, title: titleFor(s), agent: s.agent, state: PondThreadState(s), mark: markFor(s),
                    lastAt: s.lastActivityAt, local: s.key, pondThread: thread?.id, nest: thread?.nestName ?? thread?.nest, ducklingsRunning: s.helpersKeepWorking ? (s.ducklings?.running ?? 0) : 0, isLooping: s.isLoopingNow, loopSentence: s.loopingSentence, people: thread.map(people) ?? [you])
                    .withPrivate(thread?.isPrivate ?? false)
                if let id = hostIdFor(s), offDutySessions.contains(id) { made.onDuty = false; made.offDuty = offDutyNotes[id] ?? PondOffDutyNote(line: "Off duty") }
                return made
            }
            var card = PondWorkspaceCard(id: ws.id, name: ws.name, title: ws.title, branch: ws.branchLabel, mark: ws.foldedMark, chats: rows)
            card.isDucks = ws.isDucks
            if ws.isMain { card.isMain = true; card.title = ws.displayTitle; card.branch = nil }
            return card
        }
        // Main is always on a git pond's page, with or without threads.
        if let main, !cards.contains(where: \.isMain) {
            var card = PondWorkspaceCard(id: main.projectId + "/main", name: MainPlace.name, title: main.label, branch: nil, mark: nil, chats: [])
            card.isMain = true
            card.emptyMain = main
            cards.insert(card, at: 0)
        }
        // Every other non-archived branch of the pond, as the sidebar lists them: no thread yet.
        for w in emptyBranches {
            let label = SidebarWorkspace.branchLabel(branch: w.branch, name: w.name)
            cards.append(PondWorkspaceCard(id: w.projectId + "/" + w.id, name: w.name, title: w.title, branch: label, mark: nil, chats: [], empty: w))
        }
        let branches = cards.indices.reduce(into: [String: Int]()) { d, i in
            let b = cards[i].isMain ? nil : (cards[i].empty?.branch ?? project?.workspaces.first { $0.id == cards[i].id }?.branch)
            if let b, !b.isEmpty, d[b] == nil { d[b] = i }
        }
        let names = cards.indices.reduce(into: [String: Int]()) { d, i in
            let k = cards[i].name.lowercased()
            if cards[i].isMain { return }
            if d[k] == nil { d[k] = i }
        }

        var flock: [PondChatRow] = []
        // A thread someone else started that this person hid is left out of their view (the starter's and the flock's are unchanged).
        for t in threads where !used.contains(t.id) && !hiddenThreads.contains(t.id) {
            var row = PondChatRow(
                id: "thread:" + t.id, title: t.title.isEmpty ? "Untitled duck" : t.title, agent: t.agent, state: PondThreadState(raw: t.state),
                mark: nil, lastAt: t.updatedAt, local: nil, pondThread: t.id, nest: t.nestName ?? t.nest, people: people(t))
            if t.mode == .own { row.poweredBy = PondOwnThreads.poweredBy(nest: t.nestName ?? t.nest, ownThreads: ownThreads) }
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
            if $0.isMain != $1.isMain { return $0.isMain }
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
        return PondHomeLayout(workspaces: cards, fromFlock: order(flock), chatCounts: counts, threadPeople: Dictionary(uniqueKeysWithValues: threads.map { ($0.id, people($0)) }))
    }
}

/// A dashboard scope always filters the same deduplicated rows that the branch list displays.
public enum PondDashboardScope: String, CaseIterable, Sendable {
    case all, onDuty, working, needsYou, offDuty, shared

    /// The dashboard's tiles, left to right. Shared is a filter in the search field's menu, not a tile.
    public static let tiles: [PondDashboardScope] = [.onDuty, .working, .needsYou, .offDuty]

    public var title: String {
        switch self {
        case .all: "All ducks"
        case .onDuty: "On duty"
        case .working: "Working"
        case .needsYou: "Needs you"
        case .offDuty: "Off duty"
        case .shared: "Shared"
        }
    }

    public func includes(_ row: PondChatRow) -> Bool {
        switch self {
        case .all: true
        case .onDuty: row.onDuty && !row.isFlock
        case .needsYou: row.onDuty && !row.isFlock && row.state == .needsYou
        case .working: row.onDuty && !row.isFlock && (row.state == .working || (row.statusLine == nil && row.ducklingsRunning > 0))
        case .offDuty: !row.onDuty && !row.isFlock
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
        return PondHomeLayout(workspaces: cards, fromFlock: fromFlock.filter { includes($0) }, chatCounts: chatCounts, threadPeople: threadPeople)
    }
}
