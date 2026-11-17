import Foundation

// The pond room's Ripples and Now, as pure functions the view only draws (DESIGN.md §8.10; docs: the room mock-ups).
// Rows are append-only and id-stable: a turn changing is the same row with new fields, a day or group id never moves.

public enum RoomRippleFilter: String, Sendable, CaseIterable, Equatable {
    case all, needsYou, people, agents
    public var title: String {
        switch self { case .all: "All"; case .needsYou: "Needs you"; case .people: "People"; case .agents: "Agents" }
    }
}

/// How a turn's prompt line reads.
public enum RoomPromptLine: Sendable, Equatable {
    /// `Sibhi “…”`.
    case said(name: String, quote: String)
    /// `You answered [C] — question`.
    case answered(who: String, letter: String, question: String)
}

/// What a turn row says in ink.
public struct RoomOutcomeLine: Sendable, Equatable {
    public enum Mark: Sendable, Equatable { case none, working, attention, failed }
    public var mark: Mark
    public var text: String
}

public struct RoomTurnRow: Sendable, Equatable, Identifiable {
    public var id: String { turn.id }
    public var turn: RoomTurn
    public var prompt: RoomPromptLine?
    public var outcome: RoomOutcomeLine
    public var meta: String
    public var asking: Bool
}

/// Turns of one thread that follow each other (within 15 minutes of the last one ending, nothing else between).
public struct RoomThreadGroup: Sendable, Equatable, Identifiable {
    /// The first turn's id: a group only grows at its end.
    public var id: String { "g:" + rows[0].id }
    public var sessionId: String
    public var title: String
    public var agent: String?
    public var rows: [RoomTurnRow]
    public var countLabel: String { rows.count == 1 ? "1 turn" : "\(rows.count) turns" }
}

public struct RoomHandoff: Sendable, Equatable, Identifiable {
    public var id: String
    public var at: Int64
    public var fromTitle: String
    public var fromSessionId: String?
    public var toTitle: String?
    public var toSessionId: String?
    public var quote: String
    /// "holds renderer/**" style scope chips, read off the post's text.
    public var scope: String?
}

public enum RoomRipple: Sendable, Equatable, Identifiable {
    case day(id: String, label: String)
    case threadTurns(RoomThreadGroup)
    case bubble(RoomRow, mine: Bool)
    case handoff(RoomHandoff)
    /// Fallback from posts (a host without turns): a working/done/needs line of a thread.
    case event(RoomRow, title: String, agent: String?)

    public var id: String {
        switch self {
        case .day(let id, _): id
        case .threadTurns(let g): g.id
        case .bubble(let r, _): r.id
        case .handoff(let h): h.id
        case .event(let r, _, _): r.id
        }
    }
}

public enum RoomRipples {
    public static let groupGap: Int64 = 15 * 60 * 1000

    /// Everything the Ripples draw, oldest first.
    public static func build(
        feed: RoomFeed, filter: RoomRippleFilter, now: Date = Date(), calendar: Calendar = .current
    ) -> [RoomRipple] {
        var items: [Item] = []
        let titles = Dictionary(feed.threads.map { ($0.sessionId, $0.title) }, uniquingKeysWith: { a, _ in a })
        let askingNow = Set(feed.threads.filter { $0.state == .waiting }.map(\.sessionId))

        if feed.servesTurns {
            // The latest turn of an asking thread is the asked row.
            var latest: [String: String] = [:]
            for t in feed.turns where t.outcome == nil || t.endedAt == nil { latest[t.sessionId] = t.id }
            for t in feed.turns {
                let asking = askingNow.contains(t.sessionId) && latest[t.sessionId] == t.id
                items.append(Item(at: t.startedAt, order: 1, kind: .turn(row(t, asking: asking, now: now))))
            }
        }
        for r in feed.rows {
            let p = r.post
            if p.kind == .handoff || (p.level == .agents && p.author.kind != .person) {
                if p.kind == .handoff || p.toSessionId != nil {
                    items.append(Item(at: p.at, order: 2, kind: .handoff(handoff(r, titles: titles))))
                }
            } else if p.author.kind == .person, p.level == .room {
                items.append(Item(at: p.at, order: 2, kind: .bubble(r)))
            } else if !feed.servesTurns, p.level == .room, p.kind != .message {
                items.append(Item(at: p.at, order: 2, kind: .event(r, title: p.sessionId.flatMap { titles[$0] } ?? p.author.name, agent: nil)))
            }
        }
        items.sort { ($0.at, $0.order, $0.id) < ($1.at, $1.order, $1.id) }
        items = items.filter { include($0, filter) }
        return assemble(items, now: now, calendar: calendar)
    }

    // MARK: Internals

    private struct Item {
        enum Kind { case turn(RoomTurnRow), bubble(RoomRow), handoff(RoomHandoff), event(RoomRow, title: String, agent: String?) }
        var at: Int64
        var order: Int
        var kind: Kind
        var id: String {
            switch kind {
            case .turn(let r): r.id
            case .bubble(let r): r.id
            case .handoff(let h): h.id
            case .event(let r, _, _): r.id
            }
        }
    }

    private static func include(_ item: Item, _ f: RoomRippleFilter) -> Bool {
        switch (f, item.kind) {
        case (.all, _): return true
        case (.needsYou, .turn(let r)): return r.asking || r.turn.answer != nil
        case (.needsYou, .event(let r, _, _)): return r.post.kind == .needs
        case (.needsYou, _): return false
        case (.people, .bubble): return true
        case (.people, _): return false
        case (.agents, .turn), (.agents, .handoff), (.agents, .event): return true
        case (.agents, .bubble): return false
        }
    }

    private static func assemble(_ items: [Item], now: Date, calendar: Calendar) -> [RoomRipple] {
        var out: [RoomRipple] = []
        var lastDay: DateComponents?
        var openGroup: Int?  // index in `out` of the group still growing
        for item in items {
            let day = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(item.at) / 1000))
            if day != lastDay {
                lastDay = day
                openGroup = nil
                let id = "day-\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)"
                out.append(.day(id: id, label: dayLabel(item.at, now: now, calendar: calendar)))
            }
            switch item.kind {
            case .turn(let row):
                if let i = openGroup, case .threadTurns(var g) = out[i], g.sessionId == row.turn.sessionId,
                    let prev = g.rows.last?.turn, row.turn.startedAt - (prev.endedAt ?? prev.startedAt) <= groupGap {
                    g.rows.append(row)
                    out[i] = .threadTurns(g)
                } else {
                    out.append(.threadTurns(RoomThreadGroup(
                        sessionId: row.turn.sessionId, title: row.turn.threadTitle, agent: row.turn.agent, rows: [row])))
                    openGroup = out.count - 1
                }
            case .bubble(let r): openGroup = nil; out.append(.bubble(r, mine: r.post.author.kind == .person && isMine(r)))
            case .handoff(let h): openGroup = nil; out.append(.handoff(h))
            case .event(let r, let t, let a): openGroup = nil; out.append(.event(r, title: t, agent: a))
            }
        }
        return out
    }

    /// A message typed here is "You"; the host names the owner's own posts by the name it was given or "You".
    private static func isMine(_ r: RoomRow) -> Bool { r.mine || r.pending || r.post.author.name == "You" || r.post.author.id == "me" || r.post.author.id == "owner" }

    static func row(_ t: RoomTurn, asking: Bool, now: Date) -> RoomTurnRow {
        RoomTurnRow(turn: t, prompt: promptLine(t), outcome: outcomeLine(t, asking: asking), meta: metaLine(t, asking: asking, now: now), asking: asking)
    }

    public static func promptLine(_ t: RoomTurn) -> RoomPromptLine? {
        if let a = t.answer {
            return .answered(who: t.author.me ? "You" : (t.author.name.isEmpty ? "Someone" : t.author.name), letter: a.letter, question: a.question)
        }
        let p = t.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return nil }
        return .said(name: t.author.name.isEmpty ? (t.author.me ? "You" : "Someone") : t.author.name, quote: p)
    }

    public static func outcomeLine(_ t: RoomTurn, asking: Bool) -> RoomOutcomeLine {
        if asking {
            let lead = t.outcomeText ?? t.intent ?? ""
            let text = lead.lowercased().hasSuffix("waiting on you.") || lead.lowercased().hasSuffix("waiting on you") ? lead : (lead.isEmpty ? "Waiting on you" : lead + " Waiting on you.")
            return RoomOutcomeLine(mark: .attention, text: text)
        }
        switch t.outcome {
        case nil: return RoomOutcomeLine(mark: .working, text: t.intent ?? t.outcomeText ?? "Working")
        case .finished: return RoomOutcomeLine(mark: .none, text: t.outcomeText ?? "Finished")
        case .stopped: return RoomOutcomeLine(mark: .none, text: t.outcomeText ?? "Stopped")
        case .error: return RoomOutcomeLine(mark: .failed, text: t.outcomeText ?? "Hit an error")
        }
    }

    public static func metaLine(_ t: RoomTurn, asking: Bool, now: Date) -> String {
        if asking { return "answer above" }
        var parts: [String] = []
        if t.outcome == nil {
            if let p = t.progress { parts.append("step \(p.current) of \(p.total)") }
            else { parts.append(elapsed(ms: Int64(now.timeIntervalSince1970 * 1000) - t.startedAt, running: true)) }
        } else if let d = t.durationMs ?? t.endedAt.map({ $0 - t.startedAt }) {
            parts.append(duration(ms: d))
        }
        if let f = t.filesChanged, f > 0 { parts.append(fileCount(f)) }
        return parts.joined(separator: " \u{00B7} ")
    }

    public static func fileCount(_ n: Int) -> String { n == 1 ? "1 file" : "\(n) files" }

    /// "14 s", "1m 40s", "2m 08s", "1h 05m".
    public static func duration(ms: Int64) -> String {
        let s = max(0, Int(ms / 1000))
        if s < 60 { return "\(s) s" }
        if s < 3600 { return String(format: "%dm %02ds", s / 60, s % 60) }
        return String(format: "%dh %02dm", s / 3600, (s % 3600) / 60)
    }

    /// "4 min", "just started".
    public static func elapsed(ms: Int64, running: Bool) -> String {
        let m = max(0, Int(ms / 60_000))
        if m < 1 { return "just started" }
        if m < 60 { return "\(m) min" }
        return "\(m / 60) h \(m % 60) min"
    }

    public static func dayLabel(_ at: Int64, now: Date, calendar: Calendar) -> String {
        let d = Date(timeIntervalSince1970: Double(at) / 1000)
        if calendar.isDate(d, inSameDayAs: now) { return "Today" }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(d, inSameDayAs: y) { return "Yesterday" }
        let f = DateFormatter()
        f.calendar = calendar; f.timeZone = calendar.timeZone; f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE d MMM"
        return f.string(from: d)
    }

    /// "15:02" in the calendar's time zone.
    public static func clock(_ at: Int64, calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.calendar = calendar; f.timeZone = calendar.timeZone; f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: Double(at) / 1000))
    }

    private static func handoff(_ r: RoomRow, titles: [String: String]) -> RoomHandoff {
        let p = r.post
        let from = p.sessionId.flatMap { titles[$0] } ?? RoomPresentation.authorName(p.author)
        let to = p.toSessionId.flatMap { titles[$0] }
        // A scope reads as a trailing "(holds renderer/**)" the agent put on its message.
        var text = p.text, scope: String?
        if let open = text.range(of: " (holds ", options: .backwards), text.hasSuffix(")") {
            scope = String(text[text.index(open.lowerBound, offsetBy: 2)..<text.index(before: text.endIndex)])
            text = String(text[..<open.lowerBound])
        }
        return RoomHandoff(id: r.id, at: p.at, fromTitle: from, fromSessionId: p.sessionId, toTitle: to, toSessionId: p.toSessionId, quote: text, scope: scope)
    }
}

// MARK: Now

public struct RoomNowCard: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable { case needsYou, working, unread }
    public var id: String { thread.sessionId }
    public var thread: RoomThread
    public var kind: Kind
    /// Needs-you with a question: drawn full width, first.
    public var fullWidth: Bool { kind == .needsYou && thread.ask != nil }
    public var meta: String
}

public enum RoomNow {
    /// Working, needs-you and finished-unread threads. Newest turn start first and never reordered by state, except that a
    /// question leads (it is the one card that needs a hand). The sort key is the turn's start, which does not change
    /// while a turn runs, so a card never jumps on a refresh.
    public static func cards(threads: [RoomThread], unread: Set<String>, now: Date = Date(), filesFor: (String) -> Int? = { _ in nil }) -> [RoomNowCard] {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        var cards: [RoomNowCard] = []
        for var t in threads {
            // The host sends no file count: the app's own Changes read for that workspace fills it in.
            if t.filesChanged == nil { t.filesChanged = filesFor(t.sessionId) }
            let kind: RoomNowCard.Kind
            switch t.state {
            case .working: kind = .working
            case .waiting: kind = .needsYou
            case .idle, .error:
                guard unread.contains(t.sessionId) else { continue }
                kind = .unread
            }
            cards.append(RoomNowCard(thread: t, kind: kind, meta: meta(t, kind: kind, nowMs: nowMs)))
        }
        func key(_ c: RoomNowCard) -> Int64 { c.thread.turnStartedAt ?? c.thread.lastAt ?? 0 }
        cards.sort { a, b in
            if a.fullWidth != b.fullWidth { return a.fullWidth }
            if key(a) != key(b) { return key(a) > key(b) }
            return a.thread.title.localizedCompare(b.thread.title) == .orderedAscending
        }
        return cards
    }

    static func meta(_ t: RoomThread, kind: RoomNowCard.Kind, nowMs: Int64) -> String {
        var parts: [String] = []
        switch kind {
        case .needsYou:
            if let s = t.turnStartedAt ?? t.workingOnAt { parts.append("Waiting " + RoomRipples.elapsed(ms: nowMs - s, running: true)) }
        case .working:
            if let s = t.turnStartedAt { parts.append(RoomRipples.elapsed(ms: nowMs - s, running: true)) }
        case .unread:
            if let a = t.lastAt { parts.append("finished " + RoomPresentation.relativeTime(at: a, now: Date(timeIntervalSince1970: Double(nowMs) / 1000)) + " ago") }
        }
        if let f = t.filesChanged, f > 0 { parts.append(RoomRipples.fileCount(f)) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The card's intent line: the agent's own words.
    public static func intent(_ c: RoomNowCard) -> String {
        switch c.kind {
        case .needsYou: c.thread.ask?.question ?? c.thread.workingOn ?? "Waiting on you"
        case .working: c.thread.workingOn ?? "Working"
        case .unread: c.thread.workingOn ?? RoomPresentation.recentLine(c.thread, now: Date())
        }
    }
}

// MARK: Header, today, composer

public enum RoomSummary {
    public struct Line: Sendable, Equatable {
        public var working: Int
        public var needsYou: Int
        /// "All quiet" with "last activity 12 min ago" when nothing is working or waiting.
        public var quiet: Bool
        public var quietDetail: String?
    }

    public static func line(feed: RoomFeed, now: Date = Date()) -> Line {
        let working = feed.threads.filter { $0.state == .working }.count
        let needs = feed.threads.filter { $0.state == .waiting }.count
        guard working == 0, needs == 0 else { return Line(working: working, needsYou: needs, quiet: false, quietDetail: nil) }
        let last = ([feed.threads.compactMap(\.lastAt), feed.turns.map { $0.endedAt ?? $0.startedAt }, feed.rows.map(\.post.at)]).flatMap { $0 }.max()
        guard let last, last > 0 else { return Line(working: 0, needsYou: 0, quiet: true, quietDetail: nil) }
        let s = max(0, Int(now.timeIntervalSince1970 - Double(last) / 1000))
        let text: String
        switch s {
        case ..<60: text = "just now"
        case ..<3600: text = "\(s / 60) min ago"
        case ..<86_400: text = "\(s / 3600) h ago"
        default: text = "\(s / 86_400) d ago"
        }
        return Line(working: 0, needsYou: 0, quiet: true, quietDetail: "last activity " + text)
    }

    public struct Today: Sendable, Equatable { public var turns: Int; public var files: Int; public var threads: Int }

    public static func today(turns: [RoomTurn], now: Date = Date(), calendar: Calendar = .current) -> Today {
        let t = turns.filter { calendar.isDate(Date(timeIntervalSince1970: Double($0.startedAt) / 1000), inSameDayAs: now) }
        return Today(turns: t.count, files: t.reduce(0) { $0 + ($1.filesChanged ?? 0) }, threads: Set(t.map(\.sessionId)).count)
    }
}

public enum RoomAddressee: Sendable, Equatable {
    case everyone
    case thread(sessionId: String, title: String)
    case person(name: String)

    public var label: String {
        switch self { case .everyone: "Everyone"; case .thread(_, let t): t; case .person(let n): n }
    }
}

public enum RoomMention {
    public struct Active: Sendable, Equatable {
        public var query: String
        /// The `@query` token's range in the draft.
        public var range: Range<String.Index>
    }

    /// The `@token` being typed at the end of the draft (an `@` at the start or after a space, no space yet after it).
    public static func active(in draft: String) -> Active? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at != draft.startIndex, !draft[draft.index(before: at)].isWhitespace { return nil }
        let rest = draft[draft.index(after: at)...]
        guard !rest.contains(where: \.isWhitespace) || rest.isEmpty else { return nil }
        return Active(query: String(rest), range: at..<draft.endIndex)
    }

    public struct Candidate: Sendable, Equatable, Identifiable {
        public var id: String
        public var addressee: RoomAddressee
        public var subtitle: String
        public init(id: String, addressee: RoomAddressee, subtitle: String) { self.id = id; self.addressee = addressee; self.subtitle = subtitle }
    }

    /// Threads first (working ones, then the rest), then people; matched on a title or name prefix of any word.
    public static func candidates(query: String, threads: [RoomThread], people: [String]) -> [Candidate] {
        let q = query.lowercased()
        func match(_ s: String) -> Bool {
            q.isEmpty || s.lowercased().split(separator: " ").contains { $0.hasPrefix(q) } || s.lowercased().hasPrefix(q)
        }
        let ts = threads.filter { match($0.title) }.sorted {
            ($0.state == .working || $0.state == .waiting ? 0 : 1, $0.title) < ($1.state == .working || $1.state == .waiting ? 0 : 1, $1.title)
        }.map { Candidate(id: "t:" + $0.sessionId, addressee: .thread(sessionId: $0.sessionId, title: $0.title), subtitle: RoomPresentation.chipLine($0)) }
        let ps = people.filter(match).map { Candidate(id: "p:" + $0, addressee: .person(name: $0), subtitle: "Person") }
        return ts + ps
    }

    /// The draft with the active `@token` removed once an addressee is picked.
    public static func removing(_ a: Active, from draft: String) -> String {
        var d = draft
        d.replaceSubrange(a.range, with: "")
        return d
    }

    /// What goes to the room for a person addressee: their name leads the message.
    public static func roomText(_ text: String, to: RoomAddressee) -> String {
        if case .person(let n) = to { return "@\(n) \(text)" }
        return text
    }
}
