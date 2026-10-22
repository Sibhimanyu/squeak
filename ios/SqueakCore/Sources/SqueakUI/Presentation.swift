import Foundation
import SqueakCore

/// How a snapshot's fields read on the phone. Pure functions over what the
/// Mac already sends, kept free of UIKit so `swift test` covers them: the
/// phone invents nothing, it only phrases it.
enum Presentation {
    /* ---------- names ---------- */

    /// The Mac labels a session "repo · title". Without the separator the
    /// whole label is the title.
    static func split(label: String) -> (repo: String?, title: String) {
        guard let range = label.range(of: " · ") else { return (nil, label) }
        let repo = String(label[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
        let title = String(label[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        return (repo.isEmpty ? nil : repo, title.isEmpty ? label : title)
    }

    /// A branch-like title ("irrigation-pull-to-refresh") as words. A title
    /// that already has spaces, or a path, is left exactly as written.
    static func readable(_ title: String) -> String {
        guard !title.contains(" "), !title.contains("/"), title.contains("-") || title.contains("_") else { return title }
        let words = title.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    static func agentName(_ agent: String) -> String {
        switch agent.lowercased() {
        case "claude": return "Claude"
        case "codex": return "Codex"
        default: return agent.prefix(1).uppercased() + agent.dropFirst()
        }
    }

    /// "storefront · Claude" (§8.2: `repo · agent`).
    static func subtitle(_ session: PhoneSnapshot.Session) -> String {
        let repo = split(label: session.label).repo
        return [repo, agentName(session.agent)].compactMap { $0 }.joined(separator: " · ")
    }

    /// `repo · branch`: the label without a trailing "(title)" the Mac adds when two rows collide.
    static func repoBranch(_ session: PhoneSnapshot.Session) -> String {
        var label = session.label
        if label.hasSuffix(")"), let open = label.range(of: " (", options: .backwards) { label = String(label[..<open.lowerBound]) }
        return label
    }

    /// The chat's title: the `title` the Mac sends, else the "(title)" in a disambiguated label.
    static func ownTitle(_ session: PhoneSnapshot.Session) -> String? {
        var title = session.title
        if title == nil, session.label.hasSuffix(")"), let open = session.label.range(of: " (", options: .backwards) {
            title = String(session.label[open.upperBound...].dropLast())
        }
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty || t.lowercased() == "untitled" ? nil : t
    }

    /// §8.2's headline: the chat's own title, else `repo · branch` (untitled chats, terminal sessions).
    static func displayTitle(_ session: PhoneSnapshot.Session) -> String {
        ownTitle(session) ?? repoBranch(session)
    }

    /// The first non-empty line of an agent's message, markdown markers stripped, for a one-line preview.
    static func firstLine(_ text: String?) -> String? {
        guard let text else { return nil }
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            while let first = line.first, "#>*-•".contains(first) { line.removeFirst(); line = line.trimmingCharacters(in: .whitespaces) }
            line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            if !line.isEmpty { return line }
        }
        return nil
    }

    /// The chat header's second line, longest first, for ViewThatFits to pick
    /// the one that fits. Never two the same: without a diff (or a repo) the
    /// candidates repeat, and ViewThatFits crashes on duplicate children.
    static func headerLines(state: String, subtitle: String, git: String?) -> [String] {
        let candidates = [
            [state, subtitle, git ?? ""],
            [state, subtitle],
            [state],
        ].map { $0.filter { !$0.isEmpty }.joined(separator: " · ") }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0).inserted }
    }

    /* ---------- status ---------- */

    /// One tone per state (DESIGN.md §3.3); only the dot carries the colour.
    enum Tone: Equatable { case needsYou, working, done, error, idle }

    struct Status: Equatable {
        let text: String
        let tone: Tone
    }

    /// The row's status line, in DESIGN.md §9's words. A working session says
    /// what its newest step is, in the agent's own words, when the Mac sent one.
    static func status(_ session: PhoneSnapshot.Session) -> Status {
        switch session.state {
        case "awaiting_approval": return .init(text: "needs approval", tone: .needsYou)
        case "awaiting_input": return .init(text: "needs an answer", tone: .needsYou)
        case "working":
            guard let phrase = stepPhrase(session.activity?.steps ?? []) else {
                return .init(text: "working", tone: .working)
            }
            return .init(text: phrase, tone: .working)
        case "finished": return .init(text: "done", tone: .done)
        case "error": return .init(text: "error", tone: .error)
        default: return .init(text: "idle", tone: .idle)
        }
    }

    /// §8.2's third line while working, the same phrasing as the Mac's row ("running tests", "editing 2
    /// files"). Nil when there are no steps or the newest is not recognised: the row says "working".
    static func stepPhrase(_ steps: [PhoneSnapshot.Step]) -> String? {
        guard let last = steps.last else { return nil }
        let phrase: String
        switch last.kind {
        case "thinking": phrase = "thinking"
        case "note", "text": phrase = "writing"
        case "background": phrase = "waiting on workers"
        default:
            let lower = last.text.lowercased()
            if lower.hasPrefix("edit") || lower.hasPrefix("write") {
                var files = Set<String>()
                for step in steps.reversed() {
                    guard step.kind == "tool" else { continue }
                    let l = step.text.lowercased()
                    guard l.hasPrefix("edit") || l.hasPrefix("write") else { break }
                    files.insert(step.text.split(separator: " ", maxSplits: 1).dropFirst().first.map(String.init) ?? step.text)
                }
                phrase = files.count <= 1 ? "editing a file" : "editing \(files.count) files"
            } else if lower.hasPrefix("read") {
                phrase = "reading code"
            } else if lower.hasPrefix("search") || lower.hasPrefix("find") {
                phrase = "searching code"
            } else if lower.hasPrefix("run") || lower.contains("test") {
                if lower.contains("test") || lower.contains("vitest") || lower.contains("pytest") || lower.contains("jest") { phrase = "running tests" }
                else if lower.contains("build") || lower.contains("compile") || lower.contains("tsc") { phrase = "building" }
                else if lower.contains("lint") { phrase = "linting" }
                else if lower.contains("git ") { phrase = "checking git" }
                else { phrase = "running a command" }
            } else if lower.hasPrefix("fetch") || lower.contains("web") {
                phrase = "browsing the web"
            } else if lower.hasPrefix("start") {
                phrase = "starting a helper"
            } else if lower.hasPrefix("update the plan") {
                phrase = "planning"
            } else {
                // Not one we phrase: the step's own label (already plain, never raw input), shortened.
                guard let own = self.phrase(from: last.text) else { return nil }
                phrase = own.prefix(1).lowercased() + own.dropFirst()
            }
        }
        return phrase
    }

    /// A short phrase: the step's first sentence, capped.
    static func phrase(from text: String) -> String? {
        let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !flat.isEmpty else { return nil }
        var sentence = flat
        if let end = flat.range(of: #"[.!?](\s|$)"#, options: .regularExpression) {
            sentence = String(flat[..<end.lowerBound])
        }
        if sentence.count > 38 { sentence = String(sentence.prefix(36)).trimmingCharacters(in: .whitespaces) + "…" }
        return sentence
    }

    /* ---------- options ---------- */

    /// Splits an option into its title and a description: at " — ", at ": ",
    /// else after the first ". ".
    static func splitOption(_ text: String) -> (title: String, detail: String?) {
        for separator in [" — ", ": ", ". "] {
            if let range = text.range(of: separator) {
                let head = String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
                let tail = String(text[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !head.isEmpty, !tail.isEmpty { return (head, tail) }
            }
        }
        return (text.trimmingCharacters(in: .whitespacesAndNewlines), nil)
    }

    struct Reading: Equatable {
        /// Prose ahead of the options.
        var before: [String]
        /// Prose after them.
        var after: [String]
        /// A description for an option whose own title had none, read from
        /// the option's line in the same message.
        var details: [String: String]
    }

    /// Reads the agent's message around its options: the options (and the
    /// question) are drawn as cards, so their paragraphs are taken out of
    /// the prose and everything else is kept in order.
    static func read(message: String, choices: PhoneSnapshot.Choices?) -> Reading {
        let paragraphs = splitParagraphs(message)
        guard let choices else { return Reading(before: paragraphs, after: [], details: [:]) }
        let letters = Set(choices.options.map(\.letter))
        var details: [String: String] = [:]
        var kept: [(index: Int, text: String)] = []
        var firstDropped: Int?
        for (index, paragraph) in paragraphs.enumerated() {
            if let letter = optionLetter(of: paragraph), letters.contains(letter) {
                firstDropped = firstDropped ?? index
                if let detail = optionDetail(of: paragraph) { details[letter] = detail }
            } else if isQuestion(paragraph, choices.question) {
                firstDropped = firstDropped ?? index
            } else {
                kept.append((index, paragraph))
            }
        }
        let cut = firstDropped ?? paragraphs.count
        return Reading(before: kept.filter { $0.index < cut }.map(\.text),
                       after: kept.filter { $0.index > cut }.map(\.text), details: details)
    }

    /// Blank-line separated paragraphs, except that a fenced code block stays whole
    /// (its own blank lines are code, not a break).
    static func splitParagraphs(_ message: String) -> [String] {
        var out: [String] = []
        var cur: [Substring] = []
        var fence: Character?
        func flush() {
            let s = cur.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty { out.append(s) }
            cur = []
        }
        for line in message.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.drop(while: { $0 == " " })
            if t.hasPrefix("```") || t.hasPrefix("~~~") {
                if fence == nil { fence = t.first } else if fence == t.first { fence = nil }
            }
            if fence == nil, line.allSatisfy({ $0 == " " || $0 == "\t" || $0 == "\r" }), !t.hasPrefix("```") {
                flush()
            } else {
                cur.append(line)
            }
        }
        flush()
        return out
    }

    private static let optionPattern = try! NSRegularExpression(pattern: #"^\W{0,4}([A-Z])\s?[\)\.:]\s"#)

    static func optionLetter(of paragraph: String) -> String? {
        let range = NSRange(paragraph.startIndex..., in: paragraph)
        guard let match = optionPattern.firstMatch(in: paragraph, range: range),
              let letter = Range(match.range(at: 1), in: paragraph) else { return nil }
        return String(paragraph[letter])
    }

    /// What follows the option's bold lead-in, or its first sentence.
    static func optionDetail(of paragraph: String) -> String? {
        let body = paragraph.replacingOccurrences(of: #"^\W{0,4}[A-Z]\s?[\)\.:]\s*"#, with: "", options: .regularExpression)
        var rest = body
        if body.hasPrefix("**") || paragraph.contains("**") {
            // "**A) Arm it now (recommended).** I set …" -> "I set …"
            let parts = paragraph.components(separatedBy: "**")
            if parts.count >= 3 { rest = parts[2...].joined(separator: "**") }
        } else if let end = body.range(of: ". ") {
            rest = String(body[end.upperBound...])
        } else {
            return nil
        }
        let plain = plainText(rest)
        return plain.isEmpty ? nil : plain
    }

    private static func isQuestion(_ paragraph: String, _ question: String?) -> Bool {
        let flat = plainText(paragraph).lowercased()
        if flat.hasPrefix("(reply with") { return true }
        guard let question, !question.isEmpty else { return false }
        let wanted = plainText(question).lowercased()
        return flat.hasPrefix(wanted) || wanted.hasPrefix(flat) && flat.count > 12
    }

    /// Markdown reduced to its words: emphasis, code ticks, links and list marks gone.
    static func plainText(_ text: String) -> String {
        text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "__", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /* ---------- search & filter ---------- */

    enum Filter: String, CaseIterable, Identifiable {
        case all, needsYou, working, done, error, idle
        var id: String { rawValue }

        /// The state's word (DESIGN.md §9).
        var word: String {
            switch self {
            case .all: return "all"
            case .needsYou: return "needs you"
            case .working: return "working"
            case .done: return "done"
            case .error: return "error"
            case .idle: return "idle"
            }
        }
    }

    /// Which filter a session belongs to ("All" holds everything).
    static func inFilter(_ session: PhoneSnapshot.Session, _ filter: Filter) -> Bool {
        switch filter {
        case .all: return true
        case .needsYou: return session.needsYou
        case .working: return session.state == "working"
        case .done: return session.state == "finished"
        case .error: return session.state == "error"
        case .idle: return !session.needsYou && !["working", "finished", "error"].contains(session.state)
        }
    }

    /* ---------- home: by project or by status ---------- */

    /// Home's two ways to group the active chats. Each is one short list of groups; a tap opens
    /// the group's chats. Nothing else is on Home.
    enum Grouping: String, CaseIterable, Identifiable {
        case projects, status
        var id: String { rawValue }
        var title: String { self == .projects ? "Projects" : "Status" }
    }

    /// The states Home lists under Status, in attention order, only those with something in them.
    static func statusGroups(_ sessions: [PhoneSnapshot.Session]) -> [(filter: Filter, count: Int)] {
        let order: [Filter] = [.needsYou, .working, .done, .error, .idle]
        return order.compactMap { filter in
            let count = sessions.filter { inFilter($0, filter) }.count
            return count == 0 ? nil : (filter, count)
        }
    }

    /// The Sessions header's line: how many chats are on screen and how many work right now
    /// ("6 sessions · 3 working"). "6 active" read as six busy agents when three were idle.
    static func headerCount(_ sessions: [PhoneSnapshot.Session]) -> String {
        guard !sessions.isEmpty else { return "Nothing active" }
        let total = sessions.count == 1 ? "1 session" : "\(sessions.count) sessions"
        let working = sessions.filter { $0.state == "working" }.count
        return working > 0 ? "\(total) · \(working) working" : total
    }

    /// A project's subline, in words rather than a dot per chat: how many chats it holds and what each
    /// state has, in attention order ("3 sessions · 1 needs you · 1 working"). Every chat is counted in
    /// exactly one state, idle included, so the parts add up to the total; a project whose chats are all
    /// in one state says the state once ("2 sessions · idle").
    static func projectSummary(_ sessions: [PhoneSnapshot.Session]) -> String {
        let total = sessions.count == 1 ? "1 session" : "\(sessions.count) sessions"
        let counts: [(Filter, Int)] = [Filter.needsYou, .working, .done, .error, .idle].compactMap { filter in
            let count = sessions.filter { inFilter($0, filter) }.count
            return count > 0 ? (filter, count) : nil
        }
        func word(_ filter: Filter, _ count: Int) -> String { filter == .needsYou && count > 1 ? "need you" : filter.word }
        if counts.count == 1, let only = counts.first { return "\(total) · \(word(only.0, only.1))" }
        return ([total] + counts.map { "\($0.1) \(word($0.0, $0.1))" }).joined(separator: " · ")
    }

    /// Up to this many chats, a state's group opens in place on Home; a longer one opens its own list.
    static let inlineLimit = 6

    /// Whether tapping a state's header expands it where it is. Needs you always opens its decision
    /// cards instead: its one-tap answers are the reason to go there.
    static func expandsInline(_ filter: Filter, count: Int) -> Bool {
        filter != .needsYou && count <= inlineLimit
    }

    /// How many chats a Home card previews: Needs you shows up to three decisions, every other
    /// card two, so a card stays a glance and never becomes a transcript.
    static func previewLimit(for filter: Filter?) -> Int { filter == .needsYou ? 3 : 2 }

    /// A card's preview: the first `limit` chats of a group already in attention order, and how many
    /// more the group holds. Nothing is invented; a group of two shows both and says nothing more.
    static func preview(_ sessions: [PhoneSnapshot.Session], limit: Int = 2) -> (shown: [PhoneSnapshot.Session], more: Int) {
        let ordered = byAttention(sessions)
        let shown = Array(ordered.prefix(max(0, limit)))
        return (shown, ordered.count - shown.count)
    }

    /// "1 more session", "3 more sessions"; nil when nothing is hidden.
    static func moreLine(_ hidden: Int) -> String? {
        hidden <= 0 ? nil : hidden == 1 ? "1 more session" : "\(hidden) more sessions"
    }

    /// A preview row's extra line, in the agent's own words and only where the snapshot has them:
    /// what a chat needs from you, why it failed, and (when `finished` is asked for) what it last said.
    /// Nil for a working or idle chat: its state word, or its newest step, already says it.
    static func previewDetail(_ session: PhoneSnapshot.Session, finished: Bool) -> String? {
        if session.needsYou { return ask(session) }
        switch session.state {
        case "error": return failureReason(session)
        case "finished": return finished ? firstLine(session.message ?? session.detail) : nil
        default: return nil
        }
    }

    /// How many chats wait on you: the Needs you tab's badge. Zero shows no badge.
    static func needsYouCount(_ sessions: [PhoneSnapshot.Session]) -> Int {
        sessions.filter(\.needsYou).count
    }

    /// Why an errored chat failed, one line of the agent's own words; nil when the Mac did not say
    /// (an older Mac, or a turn that left no error row).
    static func failureReason(_ session: PhoneSnapshot.Session) -> String? {
        guard session.state == "error" else { return nil }
        return firstLine(session.failure)
    }

    /// Attention rank (DESIGN.md §8.2): needs you, done, working, error, idle.
    static func rank(_ session: PhoneSnapshot.Session) -> Int {
        if session.needsYou { return 0 }
        switch session.state {
        case "finished": return 1
        case "working": return 2
        case "error": return 3
        default: return 4
        }
    }

    /// Newest first among equals; an unparseable time sorts last.
    private static func newer(_ a: PhoneSnapshot.Session, _ b: PhoneSnapshot.Session) -> Bool {
        (Age.date(a.lastActivityAt) ?? .distantPast) > (Age.date(b.lastActivityAt) ?? .distantPast)
    }

    static func byAttention(_ sessions: [PhoneSnapshot.Session]) -> [PhoneSnapshot.Session] {
        sessions.sorted { rank($0) != rank($1) ? rank($0) < rank($1) : newer($0, $1) }
    }

    struct Project: Equatable, Identifiable {
        let name: String
        let sessions: [PhoneSnapshot.Session]
        var id: String { name }
    }

    /// The repository a session belongs to, from its `repo · branch` label; a session without one
    /// (a terminal agent in a plain folder) is its own project under its label.
    static func projectName(_ session: PhoneSnapshot.Session) -> String {
        split(label: repoBranch(session)).repo ?? repoBranch(session)
    }

    /// Sessions by repository. Projects in attention order (the most urgent chat in each decides,
    /// then the most recent), and each project's chats the same way.
    static func projects(_ sessions: [PhoneSnapshot.Session]) -> [Project] {
        var groups: [String: [PhoneSnapshot.Session]] = [:]
        var order: [String] = []
        for session in sessions {
            let name = projectName(session)
            if groups[name] == nil { order.append(name) }
            groups[name, default: []].append(session)
        }
        let projects = order.map { Project(name: $0, sessions: byAttention(groups[$0] ?? [])) }
        return projects.sorted { a, b in
            guard let x = a.sessions.first, let y = b.sessions.first else { return a.name < b.name }
            return rank(x) != rank(y) ? rank(x) < rank(y) : newer(x, y)
        }
    }

    /// Up to three one-tap answers for a chat in Needs you: a single, single-select question's options
    /// (answered through the `answer` command), else the agent's lettered options (sent as a reply).
    /// Empty when the phone can only open the chat (an approval, a plan, several questions).
    enum QuickAnswer: Equatable {
        case option(label: String)
        case letter(String, title: String)

        var title: String {
            switch self {
            case .option(let label): return label
            case .letter(let letter, let title): return "\(letter)  \(title)"
            }
        }
    }

    static func quickAnswers(_ session: PhoneSnapshot.Session) -> [QuickAnswer] {
        if let question = session.question {
            guard question.toolUseId != nil, question.plan == nil, question.questions.count == 1,
                  let prompt = question.questions.first, !prompt.multiSelect, (1...3).contains(prompt.options.count)
            else { return [] }
            return prompt.options.map { .option(label: $0.label) }
        }
        guard replyBlock(session) == nil, session.state != "working", let choices = session.choices,
              (1...3).contains(choices.options.count) else { return [] }
        return choices.options.map { .letter($0.letter, title: $0.title) }
    }

    /// A Needs you card's one line of what the agent wants: its question, else the state in words.
    static func ask(_ session: PhoneSnapshot.Session) -> String {
        if let question = session.question {
            if question.plan != nil { return "Wants you to approve a plan." }
            if let prompt = question.questions.first { return prompt.question }
        }
        if let asked = session.choices?.question { return asked }
        if session.state == "awaiting_approval" { return "Wants approval for a tool call. Answer it on your Mac." }
        return firstLine(session.message ?? session.detail) ?? status(session).text
    }

    static func matches(_ session: PhoneSnapshot.Session, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return true }
        let hay = [session.label, displayTitle(session), agentName(session.agent), session.detail ?? ""].joined(separator: " ").lowercased()
        return hay.contains(needle)
    }

    /// Why the phone cannot reply, or nil when it can.
    static func replyBlock(_ session: PhoneSnapshot.Session) -> String? {
        if session.conductorSessionId == nil { return "Not a Conductor session. Answer it where it runs." }
        // ANSWER-CARD: a question this phone can answer is answered on its card, not in the reply box.
        if session.state == "awaiting_input", session.question?.toolUseId != nil {
            return session.question?.plan != nil ? "Approve the plan above, or ask for changes." : "Answer the question above."
        }
        if session.needsYou { return "Waiting inside Conductor. Answer it on your Mac." }
        return nil
    }
}

/// Ages and clock times from the snapshot's ISO timestamps.
enum Age {
    static func date(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    static func minutes(_ iso: String, now: Date = Date()) -> Int? {
        date(iso).map { Int(now.timeIntervalSince($0) / 60) }
    }

    /// "now", "2m", "3h", "2d".
    static func describe(_ iso: String, now: Date = Date()) -> String {
        guard let minutes = minutes(iso, now: now) else { return "" }
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h" : "\(hours / 24)d"
    }

    /// How long ago the phone last heard from the server: "just now", "12s", "3m", "2h".
    static func sync(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }

    /// For VoiceOver: "2 minutes ago".
    static func spoken(_ iso: String, now: Date = Date()) -> String {
        guard let minutes = minutes(iso, now: now) else { return "" }
        if minutes < 1 { return "just now" }
        func unit(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s") ago" }
        if minutes < 60 { return unit(minutes, "minute") }
        let hours = minutes / 60
        return hours < 24 ? unit(hours, "hour") : unit(hours / 24, "day")
    }

    /// "10:44", in the phone's own time zone and style.
    static func clock(_ iso: String) -> String {
        date(iso)?.formatted(date: .omitted, time: .shortened) ?? ""
    }
}
