import Foundation

// Helpers the room shares: durations, day labels, the owner check, today's totals, @ mentions. The room itself is
// `RoomMessages` (draft A: a group chat with the ducks); these are the words it is made of.

/// What a turn's reply says in ink.
public struct RoomOutcomeLine: Sendable, Equatable {
    public enum Mark: Sendable, Equatable { case none, working, attention, failed }
    public var mark: Mark
    public var text: String
}

public enum RoomRipples {
    /// The person's own words say "You", never their full name: the host's `me` flag, or a name that is the owner's.
    public static func isOwner(_ a: RoomTurnAuthor, owner: String?) -> Bool {
        if a.me { return true }
        let n = a.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !n.isEmpty, let o = owner?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !o.isEmpty else { return false }
        return n == o || n == "you"
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
}

// MARK: Composer

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
        /// What picking it types into the draft in place of the `@token`; set for a Closed Duck, whose mention wakes it.
        public var insertion: String?
        public init(id: String, addressee: RoomAddressee, subtitle: String, insertion: String? = nil) {
            self.id = id; self.addressee = addressee; self.subtitle = subtitle; self.insertion = insertion
        }
    }

    /// Ducks first (open, working ones, then the rest), then people; matched on a name prefix of any word.
    public static func candidates(query: String, threads: [RoomThread], people: [String], now: Date = Date()) -> [Candidate] {
        let q = query.lowercased()
        func match(_ s: String) -> Bool {
            q.isEmpty || s.lowercased().split(separator: " ").contains { $0.hasPrefix(q) } || s.lowercased().hasPrefix(q)
        }
        func rank(_ t: RoomThread) -> Int { !t.isOpen ? 2 : (t.state == .working || t.state == .waiting ? 0 : 1) }
        let ts = threads.filter { match($0.heading) }.sorted { (rank($0), $0.heading) < (rank($1), $1.heading) }
            .map { t -> Candidate in
                if t.isOpen {
                    return Candidate(id: "t:" + t.sessionId, addressee: .thread(sessionId: t.sessionId, title: t.duckName), subtitle: RoomDucks.duck(t).presenceLine)
                }
                // Closed: known by its chat title; "Closed 3d ago" and its last summary under it; picking it types a mention that wakes it.
                let line = RoomRoster.closedAgo(t.lastActiveAt, now: now)
                return Candidate(
                    id: "t:" + t.sessionId, addressee: .thread(sessionId: t.sessionId, title: t.heading),
                    subtitle: t.lastSummary.map { line + " \u{00B7} " + $0 } ?? line, insertion: "@" + t.heading + " ")
            }
        let ps = people.filter(match).map { Candidate(id: "p:" + $0, addressee: .person(name: $0), subtitle: "Person") }
        return ts + ps
    }

    /// The draft with the active `@token` removed once an addressee is picked.
    public static func removing(_ a: Active, from draft: String) -> String {
        var d = draft
        d.replaceSubrange(a.range, with: "")
        return d
    }

    /// What goes to the room for an addressee: the name leads the message as an @mention. A Duck's mention is what wakes it,
    /// so a message "To Pickle" is a Room message that names Pickle, never a send into its chat alone.
    public static func roomText(_ text: String, to: RoomAddressee) -> String {
        switch to {
        case .person(let n): return "@\(n) \(text)"
        case .thread(_, let title): return "@\(title) \(text)"
        case .everyone: return text
        }
    }
}
