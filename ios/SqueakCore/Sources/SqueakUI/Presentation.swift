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

    /// The chat header's second line, longest first, for ViewThatFits to pick the one that fits:
    /// `project · workspace · +added −removed` (labels-v2: no state word, no age). Context shows only
    /// when it is low. Never two the same: without a diff (or a workspace) the candidates repeat, and
    /// ViewThatFits crashes on duplicate children. Never empty.
    static func headerLines(project: String, workspace: String, git: String?, context: String? = nil) -> [String] {
        let context = context ?? ""
        let candidates = [
            [project, workspace, git ?? "", context],
            [project, workspace, git ?? ""],
            [project, workspace],
            [project],
        ].map { $0.filter { !$0.isEmpty }.joined(separator: " · ") }
        var seen = Set<String>()
        let lines = candidates.filter { !$0.isEmpty && seen.insert($0).inserted }
        return lines.isEmpty ? [""] : lines
    }

    /// The workspace (branch) half of a `repo · branch` label; empty without one.
    static func workspaceName(_ session: PhoneSnapshot.Session) -> String {
        let label = repoBranch(session)
        guard split(label: label).repo != nil else { return "" }
        return split(label: label).title
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
        case "awaiting_approval": return .init(text: "Waiting for your approval", tone: .needsYou)
        case "awaiting_input": return .init(text: "Waiting for your answer", tone: .needsYou)
        case "working":
            if session.stalled != nil { return .init(text: "seems stuck", tone: .needsYou) }
            if session.compacting == true { return .init(text: "compacting the conversation", tone: .working) }
            guard let phrase = stepPhrase(session.activity?.steps ?? []) else {
                return .init(text: "Working", tone: .working)
            }
            return .init(text: phrase, tone: .working)
        case "finished":
            return session.asksYou ? .init(text: "Waiting for your answer", tone: .needsYou) : .init(text: "Finished", tone: .done)
        case "error": return .init(text: "Failed", tone: .error)
        default: return .init(text: "", tone: .idle)
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

        /// The state's word (labels-v2: waiting, working, finished, failed; "other" is never a row label).
        var word: String {
            switch self {
            case .all: return "all"
            case .needsYou: return "waiting"
            case .working: return "working"
            case .done: return "finished"
            case .error: return "failed"
            case .idle: return "other"
            }
        }
    }

    /// Which filter a session belongs to ("All" holds everything).
    static func inFilter(_ session: PhoneSnapshot.Session, _ filter: Filter) -> Bool {
        switch filter {
        case .all: return true
        case .needsYou: return session.needsYou
        case .working: return session.state == "working"
        case .done: return session.state == "finished" && !session.needsYou
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
        var title: String { self == .projects ? "Ponds" : "Status" }
    }

    /// The states Home lists under Status, in attention order, only those with something in them.
    static func statusGroups(_ sessions: [PhoneSnapshot.Session]) -> [(filter: Filter, count: Int)] {
        let order: [Filter] = [.needsYou, .working, .done, .error, .idle]
        return order.compactMap { filter in
            let count = sessions.filter { inFilter($0, filter) }.count
            return count == 0 ? nil : (filter, count)
        }
    }

    /// The Sessions header's line: how many chats are on screen ("6 chats").
    static func headerCount(_ sessions: [PhoneSnapshot.Session]) -> String {
        guard !sessions.isEmpty else { return "Nothing active" }
        return withStates(sessions)
    }

    /// "4 chats · 1 working · 1 waiting": how many, then only the states some chat is in, the ones that matter first.
    static func withStates(_ sessions: [PhoneSnapshot.Session]) -> String {
        let waiting = sessions.filter(\.needsYou).count
        let failed = sessions.filter { !$0.needsYou && $0.state == "error" }.count
        let working = sessions.filter { !$0.needsYou && $0.state == "working" }.count
        var parts = [chatCount(sessions.count)]
        if waiting > 0 { parts.append("\(waiting) waiting") }
        if failed > 0 { parts.append("\(failed) failed") }
        if working > 0 { parts.append("\(working) working") }
        return parts.joined(separator: " · ")
    }

    /// "1 chat", "3 chats": a project's third line (labels-v2: no state counts).
    static func chatCount(_ count: Int) -> String { count == 1 ? "1 chat" : "\(count) chats" }

    /// A project's subline: how many chats, and what they are doing ("3 chats · 1 working"); the corner mark stays.
    static func projectSummary(_ sessions: [PhoneSnapshot.Session]) -> String { withStates(sessions) }

    /* ---------- marks (labels-v2) ---------- */

    /// What a row's trailing slot shows, one at a time. A folded project shows the highest in this order:
    /// waiting on you, failed, finished and unread, working.
    enum Mark: Int, Comparable {
        case none, working, unread, failed, waiting
        static func < (a: Mark, b: Mark) -> Bool { a.rawValue < b.rawValue }
    }

    /// A chat's mark. `unread` is the phone's own "answered since you last looked" (AppModel.isUnread).
    static func mark(_ session: PhoneSnapshot.Session, unread: Bool) -> Mark {
        if session.needsYou { return .waiting }
        if session.state == "error" { return .failed }
        if unread { return .unread }
        if session.state == "working" { return .working }
        return .none
    }

    /// The highest-priority mark among a project's chats, with how many chats carry it.
    static func projectMark(_ sessions: [PhoneSnapshot.Session], unread: (PhoneSnapshot.Session) -> Bool) -> (mark: Mark, count: Int) {
        let marks = sessions.map { mark($0, unread: unread($0)) }
        let top = marks.max() ?? .none
        return (top, top == .none ? 0 : marks.filter { $0 == top }.count)
    }

    enum WaitingKind { case approval, plan, question }

    /// Which waiting mark a chat gets: the amber triangle for an approval or a plan, the grey question bubble otherwise.
    static func waitingKind(_ session: PhoneSnapshot.Session) -> WaitingKind {
        if session.question?.plan != nil { return .plan }
        return session.state == "awaiting_approval" ? .approval : .question
    }

    /// The mark's words for VoiceOver and tooltips; nil when there is none (the age speaks instead).
    static func markWords(_ session: PhoneSnapshot.Session, mark: Mark) -> String? {
        switch mark {
        case .none: return nil
        case .working: return "Working"
        case .unread: return "Finished, not opened yet"
        case .failed: return "Failed"
        case .waiting:
            if session.question?.plan != nil { return "Plan ready for your review" }
            return session.state == "awaiting_approval" ? "Waiting for your approval" : "Waiting for your answer"
        }
    }

    /// A project's mark in words, with the count when several chats carry it ("Waiting for your approval, 2 chats").
    static func projectMarkWords(_ sessions: [PhoneSnapshot.Session], unread: (PhoneSnapshot.Session) -> Bool) -> String? {
        let top = projectMark(sessions, unread: unread)
        guard top.mark != .none,
              let first = sessions.first(where: { mark($0, unread: unread($0)) == top.mark }),
              let words = markWords(first, mark: top.mark) else { return nil }
        return top.count > 1 ? "\(words), \(top.count) chats" : words
    }

    /// A chat row's one muted second line: the current step while working, the ask while waiting on you,
    /// the failure reason when it failed, else the agent's last words. Nil when there is nothing to say.
    static func secondLine(_ session: PhoneSnapshot.Session) -> String? {
        if session.needsYou { return ask(session) }
        switch session.state {
        case "working":
            if session.compacting == true { return "Compacting the conversation" }
            guard let phrase = stepPhrase(session.activity?.steps ?? []) else { return "Working" }
            return phrase.prefix(1).uppercased() + phrase.dropFirst()
        case "error": return failureReason(session) ?? "Failed"
        default: return firstLine(session.message ?? session.detail)
        }
    }

    /// The row's VoiceOver label: title, then the mark's words or "last active …".
    static func rowLabel(_ session: PhoneSnapshot.Session, mark: Mark, now: Date = Date()) -> String {
        "\(displayTitle(session)), \(markWords(session, mark: mark) ?? "last active \(Age.spoken(session.lastActivityAt, now: now))")"
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
        let ordered = newestFirst(sessions)
        let shown = Array(ordered.prefix(max(0, limit)))
        return (shown, ordered.count - shown.count)
    }

    /// "1 more session", "3 more sessions"; nil when nothing is hidden.
    static func moreLine(_ hidden: Int) -> String? {
        hidden <= 0 ? nil : hidden == 1 ? "1 more session" : "\(hidden) more sessions"
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

    /// Newest first by last activity; an unparseable time sorts last; ties are stable by title.
    static func newer(_ a: PhoneSnapshot.Session, _ b: PhoneSnapshot.Session) -> Bool {
        let x = Age.date(a.lastActivityAt) ?? .distantPast, y = Age.date(b.lastActivityAt) ?? .distantPast
        return x != y ? x > y : (a.title ?? "") < (b.title ?? "")
    }

    /// Every list is newest first by last activity. Urgency lives in Needs you, not in sort order.
    static func newestFirst(_ sessions: [PhoneSnapshot.Session]) -> [PhoneSnapshot.Session] {
        sessions.sorted(by: newer)
    }

    struct Project: Equatable, Identifiable {
        let name: String
        let sessions: [PhoneSnapshot.Session]
        /// The pond the project's chats are in, when the Mac said (nil from an older Mac, or for a chat with none).
        var pond: PhoneSnapshot.Pond? = nil
        var id: String { name }
        /// Two dots on the row: the pond has people besides you.
        var shared: Bool { pond?.shared == true }
    }

    /// The repository a session belongs to, from its `repo · branch` label; a session without one
    /// (a terminal agent in a plain folder) is its own project under its label.
    static func projectName(_ session: PhoneSnapshot.Session) -> String {
        split(label: repoBranch(session)).repo ?? repoBranch(session)
    }

    /// Sessions by repository. Projects ordered by their most recent chat, newest first, and each
    /// project's chats newest first.
    static func projects(_ sessions: [PhoneSnapshot.Session], ponds: [PhoneSnapshot.Pond] = []) -> [Project] {
        var groups: [String: [PhoneSnapshot.Session]] = [:]
        var order: [String] = []
        for session in sessions {
            let name = projectName(session)
            if groups[name] == nil { order.append(name) }
            groups[name, default: []].append(session)
        }
        let projects = order.map { name -> Project in
            let chats = newestFirst(groups[name] ?? [])
            let pondId = chats.compactMap { $0.pond?.id }.first
            return Project(name: name, sessions: chats, pond: pondId.flatMap { id in ponds.first { $0.id == id } })
        }
        return projects.sorted { a, b in
            guard let x = a.sessions.first, let y = b.sessions.first else { return a.name < b.name }
            return newer(x, y) || (!newer(y, x) && a.name < b.name)
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
        return choices.options.map { .letter($0.sent, title: $0.title) }
    }

    /// A Needs you card's one line of what the agent wants: its question, else the state in words.
    static func ask(_ session: PhoneSnapshot.Session) -> String {
        if let question = session.question {
            if question.plan != nil { return "Wants you to approve a plan." }
            if let prompt = question.questions.first { return prompt.question }
        }
        if session.asksYou, let asked = session.asks { return asked }
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
        // The Mac refuses a reply to a closed chat: it would run in the background, where Conductor shows nothing.
        if session.open == false { return "Closed in Conductor. Reopen its tab there to reply." }
        // ANSWER-CARD: a question this phone can answer is answered on its card, not in the reply box.
        if session.state == "awaiting_input", session.question?.toolUseId != nil {
            return session.question?.plan != nil ? "Approve the plan above, or ask for changes." : "Answer the question above."
        }
        if session.isBlocked { return "Waiting inside Conductor. Answer it on your Mac." }
        return nil
    }
}

/// Whether an answer card still has a question to answer (ANSWER-CARD). Pure, so the rule is tested.
enum AnswerCard {
    enum Standing: Equatable { case live, answeredHere, answeredElsewhere }

    /// `shown` is the pending call the card was built for. It is live only while the session still waits
    /// on that very call; otherwise it is answered, here if this phone's answer was confirmed by the Mac,
    /// else elsewhere. A card with no id (an older Mac) is live while any question is pending.
    static func standing(shown: String?, session: PhoneSnapshot.Session, answeredHere: Bool) -> Standing {
        if answeredHere { return .answeredHere }
        guard session.state == "awaiting_input", let pending = session.question else { return .answeredElsewhere }
        if let shown, pending.toolUseId != shown { return .answeredElsewhere }
        return .live
    }
}

/// Ages and clock times from the snapshot's ISO timestamps.
enum Age {
    static func date(_ iso: String) -> Date? { ISOTime.parse(iso) }

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

/// What the Earlier page can narrow its chats by. Pure, so the controls and the list cannot disagree.
struct EarlierFilter: Equatable {
    enum Sort: String, CaseIterable, Identifiable {
        case newest, project
        var id: String { rawValue }
        var title: String { self == .newest ? "Newest first" : "By pond" }
    }

    /// Only chats whose tab is open in Conductor.
    var openOnly = false
    var project: String?
    /// `claude` or `codex`, the session's own `agent`.
    var agent: String?
    /// How it ended: done, error or idle.
    var outcome: Presentation.Filter?
    var sort: Sort = .newest

    /// Whether anything narrows the list (sorting does not).
    var isNarrowing: Bool { openOnly || project != nil || agent != nil || outcome != nil }

    mutating func clear() { self = EarlierFilter(sort: sort) }

    func apply(_ sessions: [PhoneSnapshot.Session], query: String = "") -> [PhoneSnapshot.Session] {
        Presentation.newestFirst(sessions).filter { session in
            (!openOnly || session.open == true)
                && (project.map { Presentation.projectName(session) == $0 } ?? true)
                && (agent.map { session.agent.lowercased() == $0 } ?? true)
                && (outcome.map { Presentation.inFilter(session, $0) } ?? true)
                && Presentation.matches(session, query: query)
        }
    }

    /// The projects the chats belong to, newest chat first, with how many each has.
    static func projects(_ sessions: [PhoneSnapshot.Session]) -> [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for session in sessions {
            let name = Presentation.projectName(session)
            if counts[name] == nil { order.append(name) }
            counts[name, default: 0] += 1
        }
        return order.map { ($0, counts[$0] ?? 0) }
    }

    /// The agents the chats ran on, with how many each has.
    static func agents(_ sessions: [PhoneSnapshot.Session]) -> [(agent: String, count: Int)] {
        var counts: [String: Int] = [:]
        for session in sessions { counts[session.agent.lowercased(), default: 0] += 1 }
        return counts.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    /// How many chats are open in Conductor, or nil when no chat says (an older Mac): then the
    /// page has nothing to filter by and shows no switch.
    static func openCount(_ sessions: [PhoneSnapshot.Session]) -> Int? {
        sessions.contains { $0.open != nil } ? sessions.filter { $0.open == true }.count : nil
    }

    /// The chats in sections by project, projects in order of their newest chat; the chats keep their order.
    static func byProject(_ sessions: [PhoneSnapshot.Session]) -> [(name: String, sessions: [PhoneSnapshot.Session])] {
        var groups: [String: [PhoneSnapshot.Session]] = [:]
        var order: [String] = []
        for session in sessions {
            let name = Presentation.projectName(session)
            if groups[name] == nil { order.append(name) }
            groups[name, default: []].append(session)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    /// "12 of 30 chats", or "30 chats" when nothing narrows them.
    static func countLine(shown: Int, of total: Int) -> String {
        let word = total == 1 ? "chat" : "chats"
        return shown == total ? "\(total) \(word)" : "\(shown) of \(total) \(word)"
    }
}

/// The sessions the phone saw lately, so a chat open on screen never blanks. The Mac moves a chat
/// between the active list and the recent one (its turn starts, or ends), and the two reach the phone
/// as separate documents: for a moment the chat can be in neither. The screen keeps its last view of
/// the chat through that gap instead of saying it is gone.
struct SeenSessions {
    /// Longer than the two documents ever disagree; past it the chat really is gone.
    static let grace: TimeInterval = 90

    private var seen: [String: (session: PhoneSnapshot.Session, at: Date)] = [:]

    mutating func record(_ snapshot: PhoneSnapshot?, now: Date = Date()) {
        for session in snapshot?.allSessions ?? [] { seen[session.key] = (session, now) }
        seen = seen.filter { now.timeIntervalSince($0.value.at) < Self.grace }
    }

    func session(_ key: String, now: Date = Date()) -> PhoneSnapshot.Session? {
        guard let entry = seen[key], now.timeIntervalSince(entry.at) < Self.grace else { return nil }
        return entry.session
    }

    mutating func reset() { seen = [:] }
}
