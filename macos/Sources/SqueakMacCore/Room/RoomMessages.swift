import Foundation

// The pond room as a group chat with the ducks (draft A). Pure: the view only draws what `RoomMessages.build` returns.
// One conversation, oldest to newest. Rows are append-only and id-stable: a turn that changes redraws the same message
// (ids are derived from the turn, post or job, never from position), and a group's id is its first message's.

public struct RoomMessageAuthor: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case me, person, duck }
    public var kind: Kind
    /// What consecutive messages are grouped by.
    public var key: String
    public var name: String
    public var sessionId: String?
    public var agent: String?
    /// "Claude", "Codex".
    public var agentLabel: String?

    public static let me = RoomMessageAuthor(kind: .me, key: "me", name: "You")
    public static func person(_ name: String) -> RoomMessageAuthor { .init(kind: .person, key: "p:" + name.lowercased(), name: name) }
    public static func duck(_ t: RoomThread?, sessionId: String, fallbackName: String, agent: String?) -> RoomMessageAuthor {
        let a = t?.agent ?? agent
        return .init(kind: .duck, key: "d:" + sessionId, name: t?.duckName ?? (fallbackName.isEmpty ? "Duck" : fallbackName), sessionId: sessionId, agent: a, agentLabel: RoomDucks.agentLabel(a))
    }
}

public struct RoomAskCard: Sendable, Equatable {
    public var sessionId: String
    public var name: String
    public var question: String
    public var options: [RoomAskOption]
}

/// A duck offering to take a job, or asking to take it after its turn.
public struct RoomOffer: Sendable, Equatable {
    public var jobId: String
    public var text: String
    public var buttons: [RoomJobButton]
    /// Other ducks the person may pick instead of the suggested one (a menu beside Go).
    public var candidates: [RoomJobTarget]
    /// Words that replace the buttons while an action is in flight or after it was taken ("Handing over\u{2026}", "Allowed").
    public var note: String?
    public var error: String?
    public var isClaim: Bool
    /// Where the work happens, with Change; nil when the pond has no streams.
    public var place: RoomPlaceChip? = nil
}

public enum RoomPart: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case normal, attention, failed }
    case text(String, Tone)
    /// "7 files \u{00B7} 4m 20s": opens the duck's tab.
    case chip(sessionId: String, text: String)
    case ducklings(RoomDucklings)
    case ask(RoomAskCard)
    case offer(RoomOffer)
}

public struct RoomMessage: Sendable, Equatable, Identifiable {
    public var id: String
    public var at: Int64
    public var author: RoomMessageAuthor
    public var parts: [RoomPart]
    public var pending = false
    public var failed = false
    /// The room post a person's text came from: "Make this a job" and Retry act on it.
    public var postId: String?
    public var canMakeJob = false
    /// The duck this person's message went to (its turn's duck, or the job's handed duck); nil when it went to none.
    public var goesTo: String?
    /// A person's pictures and files (drawn under the words).
    public var attachments: [RoomAttachment] = []
}

public struct RoomMessageGroup: Sendable, Equatable, Identifiable {
    public var id: String { messages[0].id }
    public var author: RoomMessageAuthor
    public var messages: [RoomMessage]
    public var at: Int64 { messages[0].at }
    /// My own messages show their time once, under the last bubble.
    public var lastAt: Int64 { messages[messages.count - 1].at }
}

/// Squeak never speaks as a person: its only words are these quiet centred lines.
public struct RoomSystemLine: Sendable, Equatable, Identifiable {
    public var id: String
    public var at: Int64
    public var text: String
    public var jobId: String?
    public var buttons: [RoomJobButton]
    public var error: String?
    public var note: String?
    /// The duck whose tab the line opens (a handoff opens the duck it went to); nil for a line about no duck.
    public var opens: String?
    public var place: RoomPlaceChip? = nil
}

public enum RoomItem: Sendable, Equatable, Identifiable {
    case day(id: String, label: String)
    case group(RoomMessageGroup)
    case system(RoomSystemLine)

    public var id: String {
        switch self { case .day(let id, _): id; case .group(let g): "g:" + g.id; case .system(let s): s.id }
    }
}

/// One line at the bottom per working duck.
public struct RoomWorkingLine: Sendable, Equatable, Identifiable {
    public var id: String { sessionId }
    public var sessionId: String
    public var name: String
    public var agent: String?
    /// "updating the layout builder \u{00B7} 3 of 5"; nil when the host says neither.
    public var detail: String?
    public var spoken: String { "\(name) is working" + (detail.map { ", " + $0 } ?? "") }
}

public enum RoomMessages {
    public static let groupGap: Int64 = 5 * 60 * 1000

    private struct Entry {
        enum Content { case message(RoomMessage), system(RoomSystemLine) }
        var at: Int64
        var order: Int
        var content: Content
        var id: String {
            switch content { case .message(let m): m.id; case .system(let s): s.id }
        }
    }

    public static func build(
        feed: RoomFeed, now: Date = Date(), calendar: Calendar = .current, owner: String? = nil, filesFor: (String) -> Int? = { _ in nil }
    ) -> [RoomItem] {
        var entries: [Entry] = []
        let threads = Dictionary(feed.threads.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
        func author(_ sessionId: String, _ title: String, _ agent: String?) -> RoomMessageAuthor {
            .duck(threads[sessionId], sessionId: sessionId, fallbackName: title, agent: agent)
        }
        func add(_ m: RoomMessage, order: Int) { entries.append(Entry(at: m.at, order: order, content: .message(m))) }

        // A turn handed over by a job already has its prompt in the room: the person's message above it.
        let jobTurns = Set(feed.jobs.compactMap { $0.handedTo.flatMap(RoomJobs.turnRowId) })
        // The newest turn of each thread: the one a waiting question belongs to, and the one the app's own file count fits.
        var newest: [String: RoomTurn] = [:]
        for t in feed.turns where (newest[t.sessionId]?.startedAt ?? Int64.min) <= t.startedAt { newest[t.sessionId] = t }
        var askedSessions = Set<String>()

        for t in feed.turns {
            let thread = threads[t.sessionId]
            if !jobTurns.contains(t.id), let text = promptText(t, feed: feed) {
                let who: RoomMessageAuthor = RoomRipples.isOwner(t.author, owner: owner) ? .me : .person(t.author.name.isEmpty ? "Someone" : t.author.name)
                var asked = RoomMessage(id: "t:\(t.id):q", at: t.startedAt, author: who, parts: [.text(text, .normal)])
                asked.goesTo = t.sessionId
                add(asked, order: 0)
            }
            let asking = thread?.state == .waiting && newest[t.sessionId]?.id == t.id
            let a = author(t.sessionId, t.threadTitle, t.agent)
            if asking {
                askedSessions.insert(t.sessionId)
                add(RoomMessage(id: "t:\(t.id):a", at: t.endedAt ?? t.startedAt, author: a, parts: [askPart(thread!, fallback: t)]), order: 1)
            } else if let o = t.outcome {
                var parts: [RoomPart] = []
                let line = RoomRipples.outcomeLine(t, asking: false)
                parts.append(.text(line.text, o == .error ? .failed : .normal))
                let files = t.filesChanged ?? (newest[t.sessionId]?.id == t.id ? filesFor(t.sessionId) : nil)
                if let chip = chipText(files: files, ms: t.durationMs ?? t.endedAt.map { $0 - t.startedAt }) { parts.append(.chip(sessionId: t.sessionId, text: chip)) }
                if let d = t.ducklings, d.count > 0 { parts.append(.ducklings(d)) }
                add(RoomMessage(id: "t:\(t.id):a", at: t.endedAt ?? t.startedAt, author: a, parts: parts), order: 1)
            }
        }
        // A waiting question with no turn (a host that serves none, or a turn off the page).
        for th in feed.threads where th.state == .waiting && !askedSessions.contains(th.sessionId) {
            let at = th.turnStartedAt ?? th.workingOnAt ?? th.lastAt ?? 0
            let a = author(th.sessionId, th.title, th.agent)
            let part: RoomPart = th.ask.map { _ in askPart(th, fallback: nil) } ?? .text(th.workingOn ?? "Waiting on you", .attention)
            add(RoomMessage(id: "ask:\(th.sessionId)", at: at, author: a, parts: [part]), order: 1)
        }

        let postsById = Dictionary(feed.rows.map { ($0.post.id, $0) }, uniquingKeysWith: { a, _ in a })
        for r in feed.rows {
            let p = r.post
            if p.kind == .handoff || (p.level == .agents && p.author.kind != .person) {
                if p.kind == .handoff || p.toSessionId != nil {
                    let from = p.sessionId.flatMap { threads[$0]?.duckName } ?? RoomPresentation.authorName(p.author)
                    let to = p.toSessionId.flatMap { threads[$0]?.duckName } ?? "another duck"
                    entries.append(Entry(at: p.at, order: 0, content: .system(RoomSystemLine(
                        id: r.id, at: p.at, text: "\(from) handed off to \(to) \u{2014} \u{201C}\(p.text)\u{201D}", jobId: nil, buttons: [],
                        opens: p.toSessionId ?? p.sessionId))))
                }
            } else if p.author.kind == .person, p.level == .room {
                let mine = r.mine || r.pending || ["You"].contains(p.author.name) || p.author.id == "me" || p.author.id == "owner"
                var m = RoomMessage(
                    id: r.id, at: p.at > 0 ? p.at : Int64(now.timeIntervalSince1970 * 1000),
                    author: mine ? .me : .person(RoomPresentation.authorName(p.author)), parts: p.text.isEmpty && !p.attachments.isEmpty ? [] : [.text(p.text, .normal)])
                m.attachments = p.attachments
                m.pending = r.pending; m.failed = r.failed; m.postId = p.id
                m.canMakeJob = RoomJobs.canMakeJob(r, jobs: feed.jobs)
                m.goesTo = feed.jobs.first { $0.messageId == p.id && $0.handedTo != nil }?.handedTo?.sessionId ?? p.toSessionId
                add(m, order: 0)
            } else if p.level == .room, p.author.kind == .agent, p.kind == .message || !feed.servesTurns {
                // A duck speaking in the room (or, from a host without turns, its working / done / needs line).
                let sid = p.sessionId ?? ""
                let a = author(sid, p.author.name, nil)
                let tone: RoomPart.Tone = p.kind == .needs ? .attention : .normal
                add(RoomMessage(id: r.id, at: p.at, author: a, parts: [.text(p.text, tone)]), order: 1)
            }
        }

        for job in feed.jobs {
            let postAt = postsById[job.messageId]?.post.at ?? 0
            let at = max(job.createdAt, postAt)
            let local = feed.jobLocal[job.id]
            if let claim = job.claim, claim.status != .denied, job.status == .suggested || job.status == .handed || job.status == .running {
                if let m = claimMessage(job, claim: claim, local: local, threads: threads, at: max(at, claim.at), place: RoomPlaces.chip(for: job, chosen: feed.jobPlace[job.id])) { add(m, order: 2) }
                if claim.status == .asking { continue }
            }
            switch job.status {
            case .suggested:
                if let pend = local?.pending, pend == .dismiss { continue }
                if let s = job.suggestion {
                    add(offerMessage(job, target: s, local: local, threads: threads, at: at, place: RoomPlaces.chip(for: job, chosen: feed.jobPlace[job.id])), order: 2)
                } else {
                    entries.append(Entry(at: at, order: 2, content: .system(noDuckLine(job, local: local, at: at, place: RoomPlaces.chip(for: job, chosen: feed.jobPlace[job.id])))))
                }
            case .failed:
                let who = job.handedTo.flatMap { h in threads[h.sessionId]?.duckName ?? (h.title.isEmpty ? nil : h.title) } ?? "A duck"
                entries.append(Entry(at: max(at, job.updatedAt), order: 2, content: .system(RoomSystemLine(
                    id: "job:\(job.id):sys", at: max(at, job.updatedAt), text: "\(who) didn\u{2019}t finish this", jobId: job.id, buttons: [], opens: job.handedTo?.sessionId))))
            case .dismissed, .handed, .running, .done: break
            }
        }
        // "Make this a job" refused: no job exists yet, so the line hangs off the message.
        for (key, l) in feed.jobLocal where key.hasPrefix("msg:") {
            guard let e = l.error else { continue }
            let id = String(key.dropFirst(4))
            let at = postsById[id]?.post.at ?? 0
            entries.append(Entry(at: at, order: 2, content: .system(RoomSystemLine(id: "jobmsg:" + id, at: at, text: "Not made a job", jobId: nil, buttons: [], error: e))))
        }

        entries.sort { ($0.at, $0.order, $0.id) < ($1.at, $1.order, $1.id) }
        return assemble(entries, now: now, calendar: calendar)
    }

    // MARK: Pieces

    static func promptText(_ t: RoomTurn, feed: RoomFeed) -> String? {
        if let a = t.answer {
            if let o = a.option?.trimmingCharacters(in: .whitespacesAndNewlines), !o.isEmpty { return "\(a.letter.uppercased()) \u{2014} \(o)" }
            let opts = feed.askOptions[t.sessionId + "|" + a.question]
            if let text = opts?.first(where: { $0.letter.caseInsensitiveCompare(a.letter) == .orderedSame })?.text, !text.isEmpty {
                return "\(a.letter.uppercased()) \u{2014} \(text)"
            }
            return a.letter.uppercased()
        }
        let p = t.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return p.isEmpty ? nil : p
    }

    static func askPart(_ th: RoomThread, fallback: RoomTurn?) -> RoomPart {
        let q = th.ask?.question ?? ""
        let text = q.isEmpty ? (fallback?.outcomeText ?? th.workingOn ?? "Waiting on you") : q
        if let a = th.ask, !a.options.isEmpty || !q.isEmpty {
            return .ask(RoomAskCard(sessionId: th.sessionId, name: th.duckName, question: text, options: a.options))
        }
        return .text(text, .attention)
    }

    /// "7 files \u{00B7} 4m 20s"; nil when neither is known.
    public static func chipText(files: Int?, ms: Int64?) -> String? {
        var parts: [String] = []
        if let f = files, f > 0 { parts.append(RoomRipples.fileCount(f)) }
        if let ms, ms > 0 { parts.append(RoomRipples.duration(ms: ms)) }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    /// "handed 2 pieces to ducklings".
    public static func ducklingsLine(_ d: RoomDucklings) -> String {
        "handed \(d.count) \(d.count == 1 ? "piece" : "pieces") to ducklings"
    }

    static func shorten(_ s: String, _ n: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count <= n ? t : String(t.prefix(n - 1)) + "\u{2026}"
    }

    static func offerMessage(_ job: RoomJob, target s: RoomJobTarget, local: RoomJobLocal?, threads: [String: RoomThread], at: Int64, place: RoomPlaceChip? = nil) -> RoomMessage {
        let a = RoomMessageAuthor.duck(threads[s.sessionId], sessionId: s.sessionId, fallbackName: s.title, agent: nil)
        let words = s.pitch.map { "I can take this \u{2014} I \($0)." } ?? "I can take this."
        var note: String?
        var buttons = [
            RoomJobButton(id: "go", title: "Go", role: .primary, action: .go(sessionId: s.sessionId)),
            RoomJobButton(id: "note", title: "Not now", role: .secondary, action: .dismiss),
        ]
        if let p = local?.pending {
            switch p {
            case .go: note = "Handing over\u{2026}"; buttons = []
            case .newThread: note = "Starting a new duck\u{2026}"; buttons = []
            case .dismiss, .allow, .deny: break
            }
        }
        let others = job.candidates.filter { $0.sessionId != s.sessionId }
        return RoomMessage(
            id: "job:\(job.id):offer", at: at, author: a,
            parts: [.offer(RoomOffer(jobId: job.id, text: words, buttons: buttons, candidates: others, note: note, error: local?.error, isClaim: false, place: place))])
    }

    static func claimMessage(_ job: RoomJob, claim: RoomJobClaim, local: RoomJobLocal?, threads: [String: RoomThread], at: Int64, place: RoomPlaceChip? = nil) -> RoomMessage? {
        let a = RoomMessageAuthor.duck(threads[claim.sessionId], sessionId: claim.sessionId, fallbackName: claim.title, agent: nil)
        var words = "I\u{2019}d like to take \u{201C}\(shorten(job.text, 80))\u{201D} after this"
        if var e = claim.eta?.trimmingCharacters(in: .whitespaces), !e.isEmpty {
            if e.hasPrefix("~") { e.removeFirst(); e = e.trimmingCharacters(in: .whitespaces) }
            words += " \u{2014} about \(e)"
        }
        words += "."
        var buttons = [
            RoomJobButton(id: "allow", title: "Allow", role: .primary, action: .allow),
            RoomJobButton(id: "deny", title: "No", role: .secondary, action: .deny),
        ]
        var note: String?
        if claim.status == .allowed { buttons = []; note = "Allowed" }
        else if let p = local?.pending, p == .allow || p == .deny { buttons = []; note = p == .allow ? "Allowed" : "Okay, not now" }
        return RoomMessage(
            id: "job:\(job.id):claim", at: at, author: a,
            parts: [.offer(RoomOffer(jobId: job.id, text: words, buttons: buttons, candidates: [], note: note, error: local?.error, isClaim: true, place: place))])
    }

    static func noDuckLine(_ job: RoomJob, local: RoomJobLocal?, at: Int64, place: RoomPlaceChip? = nil) -> RoomSystemLine {
        var buttons = [
            RoomJobButton(id: "start", title: "Start a new duck", role: .secondary, action: .newThread),
            RoomJobButton(id: "note", title: "Just a note", role: .quiet, action: .dismiss),
        ]
        var note: String?
        if local?.pending == .newThread { buttons = []; note = "Starting a new duck\u{2026}" }
        return RoomSystemLine(id: "job:\(job.id):sys", at: at, text: "No duck fits this \u{2014}", jobId: job.id, buttons: buttons, error: local?.error, note: note, place: place)
    }

    private static func assemble(_ entries: [Entry], now: Date, calendar: Calendar) -> [RoomItem] {
        var out: [RoomItem] = []
        var lastDay: DateComponents?
        var open: RoomMessageGroup?
        func close() { if let g = open { out.append(.group(g)); open = nil } }
        for e in entries {
            let day = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(e.at) / 1000))
            if e.at > 0, day != lastDay {
                close()
                lastDay = day
                out.append(.day(id: "day-\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)", label: RoomRipples.dayLabel(e.at, now: now, calendar: calendar)))
            }
            switch e.content {
            case .system(let s): close(); out.append(.system(s))
            case .message(let m):
                if var g = open, g.author.key == m.author.key, m.at - g.messages[g.messages.count - 1].at <= groupGap {
                    g.messages.append(m); open = g
                } else {
                    close(); open = RoomMessageGroup(author: m.author, messages: [m])
                }
            }
        }
        close()
        return out
    }

    // MARK: Working

    /// One line per working duck, oldest turn first (the start does not change while a turn runs, so a line never jumps).
    public static func working(feed: RoomFeed) -> [RoomWorkingLine] {
        feed.threads.filter { $0.state == .working }
            .sorted { (($0.turnStartedAt ?? 0), $0.duckName, $0.sessionId) < (($1.turnStartedAt ?? 0), $1.duckName, $1.sessionId) }
            .map { t in
                var bits: [String] = []
                if let w = t.workingOn, !w.isEmpty { bits.append(w) }
                if let p = t.progress { bits.append("\(p.current) of \(p.total)") }
                return RoomWorkingLine(sessionId: t.sessionId, name: t.duckName, agent: t.agent, detail: bits.isEmpty ? nil : bits.joined(separator: " \u{00B7} "))
            }
    }
}
