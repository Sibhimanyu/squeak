import Foundation
import SqueakCore

/// The home dock's search: a typed line is read as filters (a state, an agent, a day, a project) and
/// free words; a chat shows only if it passes every kind of filter and holds every word. Pure, so `swift test`
/// covers it. Matches are newest first (owner's rule: every list is newest first; nothing is ranked by relevance).
///
/// Grammar, all case- and diacritic-insensitive:
/// - state words: `needs you` / `need you` / `waiting` / `blocked` / `question` / `asking`, `working` / `running`,
///   `done` / `finished`, `error` / `failed`, `idle`. Two states are an OR ("working done").
/// - agents: `claude`, `codex`. Two agents are an OR.
/// - days, by last activity: `today`, `yesterday`, `this week`. The last one typed wins.
/// - `project:name` or `in:name`: the project's name starts with `name`. Two projects are an OR.
/// - anything else is a word that must appear (AND with every other word) in the title, project, branch, repo label,
///   the agent's last message, or the question it asks.
/// Different kinds of filter are an AND.
enum SearchToken: Hashable {
    enum Day: String, Hashable { case today, yesterday, thisWeek }
    case state(Presentation.Filter)
    case agent(String)
    case project(String)
    case day(Day)

    /// What the chip and the removable token say.
    var title: String {
        switch self {
        case .state(let filter): filter.word.prefix(1).uppercased() + filter.word.dropFirst()
        case .agent(let agent): Presentation.agentName(agent)
        case .project(let name): name
        case .day(.today): "Today"
        case .day(.yesterday): "Yesterday"
        case .day(.thisWeek): "This week"
        }
    }
}

struct SmartQuery: Equatable {
    var tokens: [SearchToken] = []
    /// Folded free words, every one required.
    var terms: [String] = []
    /// Project names given as `project:` prefixes (a chip's exact name is a `.project` token instead).
    var projectPrefixes: [String] = []

    var isEmpty: Bool { tokens.isEmpty && terms.isEmpty && projectPrefixes.isEmpty }

    /// This query with the dock's chosen tokens added.
    func adding(_ chosen: [SearchToken]) -> SmartQuery {
        var copy = self
        for token in chosen where !copy.tokens.contains(token) { copy.tokens.append(token) }
        return copy
    }
}

enum SmartSearch {
    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    private static let phrases: [String: SearchToken] = [
        "needs you": .state(.needsYou), "need you": .state(.needsYou), "this week": .day(.thisWeek),
    ]
    private static let words: [String: SearchToken] = [
        "waiting": .state(.needsYou), "blocked": .state(.needsYou), "question": .state(.needsYou), "asking": .state(.needsYou),
        "working": .state(.working), "running": .state(.working),
        "done": .state(.done), "finished": .state(.done),
        "error": .state(.error), "failed": .state(.error),
        "idle": .state(.idle),
        "claude": .agent("claude"), "codex": .agent("codex"),
        "today": .day(.today), "yesterday": .day(.yesterday),
    ]

    static func parse(_ text: String) -> SmartQuery {
        let list = fold(text).split(whereSeparator: \.isWhitespace).map(String.init)
        var query = SmartQuery()
        var i = 0
        func add(_ token: SearchToken) {
            if case .day = token { query.tokens.removeAll { if case .day = $0 { true } else { false } } }
            if !query.tokens.contains(token) { query.tokens.append(token) }
        }
        while i < list.count {
            if i + 1 < list.count, let token = phrases[list[i] + " " + list[i + 1]] {
                add(token); i += 2; continue
            }
            let word = list[i]
            if let token = words[word] {
                add(token)
            } else if let prefix = ["project:", "in:"].first(where: { word.hasPrefix($0) }), word.count > prefix.count {
                query.projectPrefixes.append(String(word.dropFirst(prefix.count)))
            } else {
                query.terms.append(word)
            }
            i += 1
        }
        return query
    }

    /// Whether a chat passes the query as of `now`.
    static func matches(_ session: PhoneSnapshot.Session, _ query: SmartQuery, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        let states = query.tokens.compactMap { if case .state(let f) = $0 { f } else { nil } }
        if !states.isEmpty, !states.contains(where: { Presentation.inFilter(session, $0) }) { return false }
        let agents = query.tokens.compactMap { if case .agent(let a) = $0 { a } else { nil } }
        if !agents.isEmpty, !agents.contains(session.agent.lowercased()) { return false }
        let project = fold(Presentation.projectName(session))
        let exact = query.tokens.compactMap { if case .project(let n) = $0 { fold(n) } else { nil } }
        if !exact.isEmpty || !query.projectPrefixes.isEmpty {
            let hit = exact.contains(project) || query.projectPrefixes.contains { project.hasPrefix($0) }
            if !hit { return false }
        }
        if let day = query.tokens.compactMap({ if case .day(let d) = $0 { d } else { nil } }).last,
           !inDay(session.lastActivityAt, day, now: now, calendar: calendar) { return false }
        guard !query.terms.isEmpty else { return true }
        let hay = fold(haystack(session))
        return query.terms.allSatisfy { hay.contains($0) }
    }

    static func inDay(_ iso: String, _ day: SearchToken.Day, now: Date, calendar: Calendar) -> Bool {
        guard let date = Age.date(iso) else { return false }
        let today = calendar.startOfDay(for: now)
        switch day {
        case .today:
            return date >= today && date <= now
        case .yesterday:
            guard let start = calendar.date(byAdding: .day, value: -1, to: today) else { return false }
            return date >= start && date < today
        case .thisWeek:
            guard let week = calendar.dateInterval(of: .weekOfYear, for: now) else { return false }
            return date >= week.start && date <= now
        }
    }

    /// Everything a free word can match: title, project, branch and repo label, the agent's last words and its question.
    static func haystack(_ session: PhoneSnapshot.Session) -> String {
        var parts = [Presentation.displayTitle(session), Presentation.projectName(session), Presentation.repoBranch(session), session.label]
        if let title = session.title { parts.append(title) }
        if let text = session.message ?? session.detail { parts.append(text) }
        if let detail = session.detail { parts.append(detail) }
        if let asked = session.asks { parts.append(asked) }
        if let asked = session.choices?.question { parts.append(asked) }
        if let question = session.question { parts += question.questions.map(\.question) }
        return parts.joined(separator: " ")
    }

    struct Results: Equatable {
        var active: [PhoneSnapshot.Session]
        var older: [PhoneSnapshot.Session]
        var isEmpty: Bool { active.isEmpty && older.isEmpty }
    }

    /// Active chats then the earlier ones, each newest first.
    static func results(_ query: SmartQuery, active: [PhoneSnapshot.Session], older: [PhoneSnapshot.Session],
                        now: Date = Date(), calendar: Calendar = .current) -> Results {
        Results(
            active: Presentation.newestFirst(active.filter { matches($0, query, now: now, calendar: calendar) }),
            older: Presentation.newestFirst(older.filter { matches($0, query, now: now, calendar: calendar) }))
    }

    /// A suggestion above the list while the field is focused and empty.
    struct Chip: Identifiable, Equatable {
        enum Kind: Equatable { case needsYou(count: Int), token(SearchToken) }
        let kind: Kind
        var id: String {
            switch kind {
            case .needsYou: "needsYou"
            case .token(let token): "\(token)"
            }
        }
        var title: String {
            switch kind {
            case .needsYou(let count): count > 0 ? "Needs you \(count)" : "Needs you"
            case .token(let token): token.title
            }
        }
    }

    /// Needs you (with its count; it opens the decision page), Working, Done, Claude, Codex, then up to five projects,
    /// the one with the newest chat first. A chosen token is not offered again.
    static func chips(sessions: [PhoneSnapshot.Session], chosen: [SearchToken] = [], needsYouCount: Int? = nil) -> [Chip] {
        var list: [Chip] = [Chip(kind: .needsYou(count: needsYouCount ?? sessions.filter(\.needsYou).count))]
        let tokens: [SearchToken] = [.state(.working), .state(.done), .agent("claude"), .agent("codex")]
            + Presentation.projects(sessions).prefix(5).map { SearchToken.project($0.name) }
        list += tokens.filter { !chosen.contains($0) }.map { Chip(kind: .token($0)) }
        return list
    }
}
