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
    public var buttons: [RoomTaskButton]
    /// Other ducks the person may pick instead of the suggested one (a menu beside Go).
    public var candidates: [RoomTaskTarget]
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
    /// The room post a person's text came from: "Make task" and Retry act on it.
    public var postId: String?
    public var canMakeTask = false
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
    public var buttons: [RoomTaskButton]
    public var error: String?
    public var note: String?
    /// The duck whose tab the line opens (a handoff opens the duck it went to); nil for a line about no duck.
    public var opens: String?
    public var place: RoomPlaceChip? = nil
    /// A Task drawn with its state (title, Waiting / Working / ..., the messages it carries); `text` is its title then.
    public var task: RoomTaskCard? = nil
    /// A duck's note to another duck: drawn as a card (avatar, name, "to", time, Markdown), not as a quiet line.
    public var handoff: RoomHandoff? = nil
    /// A duck's state-change line, or its plan card.
    public var status: RoomStatusLine? = nil
}

/// A line that opens and closes: closed by default, one tap opens it. Pure state so the drawing is testable.
public struct RoomDisclosure: Sendable, Equatable {
    public var isOpen: Bool
    public init(startsOpen: Bool = false) { isOpen = startsOpen }
    public mutating func toggle() { isOpen.toggle() }
}

/// A duck's state change as one short line (took it, blocked, finished) or its spec+plan card. The detail shows only
/// when the line is opened; a line with no detail has nothing to open.
public struct RoomStatusLine: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case took, blocked, done, plan }
    public var kind: Kind
    public var sessionId: String?
    public var name: String
    public var agent: String?
    public var summary: String
    public var detail: String?
    /// The post a comment on this card goes to (`replyTo`); set for a plan card only.
    public var commentTarget: String?
    /// The canvases a done line carries, each a card that opens it.
    public var canvases: [RoomCanvasCard] = []
    public var isExpandable: Bool { !(detail ?? "").isEmpty }
    /// Always closed at first.
    public var disclosure: RoomDisclosure { RoomDisclosure(startsOpen: false) }
    public var verb: String {
        switch kind { case .took: "took it"; case .blocked: "is blocked"; case .done: "finished"; case .plan: "posted a plan" }
    }
    public static func kind(of post: RoomPostKind) -> Kind? {
        switch post { case .working: .took; case .needs: .blocked; case .done: .done; case .plan: .plan; case .message, .handoff: nil }
    }
}

/// A duck-to-duck note. `body` is the whole note, never cut: the view clamps it and offers Show more.
public struct RoomHandoff: Sendable, Equatable {
    public var fromSessionId: String?
    public var from: String
    public var agent: String?
    /// The receiving duck's name; nil when the post names none ("to another duck").
    public var to: String?
    public var body: String
    /// Duck-to-duck talk is closed by default: its header and first line show, the rest on a tap.
    public var disclosure: RoomDisclosure { RoomDisclosure(startsOpen: false) }
    /// The first line of the note, at most 100 characters.
    public var summary: String {
        let first = body.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let t = first.trimmingCharacters(in: .whitespaces)
        return t.count <= 100 ? t : String(t.prefix(99)) + "\u{2026}"
    }

    /// "Pip \u{2192} Sage" or "Pip \u{2192} another duck".
    public var title: String { "\(from) \u{2192} \(to ?? "another duck")" }

    /// Longer than the card shows at rest: more lines than `maxLines`, or a very long run of words.
    public static let maxLines = 6
    public static let maxChars = 480
    public var isLong: Bool { Self.isLong(body) }
    public static func isLong(_ text: String) -> Bool {
        text.count > maxChars || text.split(separator: "\n", omittingEmptySubsequences: false).count > maxLines
    }
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
        feed: RoomFeed, now: Date = Date(), calendar: Calendar = .current, owner: String? = nil, filesFor: (String) -> Int? = { _ in nil },
        memberView: Bool = false, selfId: String? = nil, canMakeMemberTask: Bool = true
    ) -> [RoomItem] {
        var entries: [Entry] = []
        let threads = Dictionary(feed.threads.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
        func author(_ sessionId: String, _ title: String, _ agent: String?) -> RoomMessageAuthor {
            .duck(threads[sessionId], sessionId: sessionId, fallbackName: title, agent: agent)
        }
        func add(_ m: RoomMessage, order: Int) { entries.append(Entry(at: m.at, order: order, content: .message(m))) }

        // A turn handed over by a job already has its prompt in the room: the person's message above it.
        let jobTurns = Set(feed.jobs.compactMap { $0.handedTo.flatMap(RoomTasks.turnRowId) })
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
                    let to = p.toSessionId.flatMap { threads[$0]?.duckName }
                    let note = RoomHandoff(
                        fromSessionId: p.sessionId, from: from, agent: p.sessionId.flatMap { threads[$0]?.agent }, to: to,
                        body: p.text.trimmingCharacters(in: .whitespacesAndNewlines))
                    entries.append(Entry(at: p.at, order: 0, content: .system(RoomSystemLine(
                        id: r.id, at: p.at, text: "\(note.title): \(note.body)", jobId: nil, buttons: [],
                        opens: p.toSessionId ?? p.sessionId, handoff: note))))
                }
            } else if feed.servesTurns, p.level == .room, p.author.kind == .agent, let kind = RoomStatusLine.kind(of: p.kind) {
                // A duck's state change (took it, blocked, finished) or plan card: one line, detail on a tap.
                let sid = p.sessionId
                let name = sid.flatMap { threads[$0]?.duckName } ?? RoomPresentation.authorName(p.author)
                let status = RoomStatusLine(
                    kind: kind, sessionId: sid, name: name, agent: sid.flatMap { threads[$0]?.agent }, summary: p.text,
                    detail: p.detail, commentTarget: kind == .plan ? p.id : nil, canvases: kind == .done ? p.canvases : [])
                entries.append(Entry(at: p.at, order: 1, content: .system(RoomSystemLine(
                    id: r.id, at: p.at, text: "\(name) \(status.verb): \(p.text)", jobId: nil, buttons: [], opens: sid, status: status))))
            } else if p.author.kind == .person, p.level == .room {
                // A Member's own messages (from any of their Macs) are theirs by member id; the Owner's are "owner" only on the Owner's Mac.
                let mine = r.mine || r.pending || ["You"].contains(p.author.name) || p.author.id == "me"
                    || (!memberView && p.author.id == "owner") || (selfId != nil && p.author.id == selfId)
                var m = RoomMessage(
                    id: r.id, at: p.at > 0 ? p.at : Int64(now.timeIntervalSince1970 * 1000),
                    author: mine ? .me : .person(RoomPresentation.authorName(p.author)), parts: p.text.isEmpty && !p.attachments.isEmpty ? [] : [.text(p.text, .normal)])
                m.attachments = p.attachments
                m.pending = r.pending; m.failed = r.failed; m.postId = p.id
                // A Member can make a Task from a message (queued for the Owner's Mac, where it may wait for approval) when they
                // may post at all; dropping and approving stay with the Owner.
                m.canMakeTask = (!memberView || canMakeMemberTask) && feed.jobLocal["msg:" + p.id]?.queued != true
                    && RoomTasks.canMakeTask(r, jobs: feed.jobs)
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
            // Every Task shows with its state; a dropped one leaves.
            if var card = RoomTasks.card(for: job, among: feed.jobs, local: local, excluded: feed.taskExcluded[job.id] ?? [], memberView: memberView) {
                if memberView { card.canDrop = false }
                entries.append(Entry(at: at, order: 1, content: .system(RoomSystemLine(
                    id: "task:\(job.id)", at: at, text: card.title, jobId: nil, buttons: [], opens: card.opens, task: card))))
            }
            if let claim = job.claim, claim.status != .denied, job.state == .waiting || job.state == .working {
                if let m = claimMessage(job, claim: claim, local: local, threads: threads, at: max(at, claim.at), place: RoomPlaces.chip(for: job, chosen: feed.jobPlace[job.id])) { add(m, order: 2) }
                if claim.status == .asking { continue }
            }
            if job.state == .waiting {
                if let pend = local?.pending, pend == .drop { continue }
                // A Member's Task waits for the Owner: the Owner gets Approve / Drop, the Member only the card's words.
                if !job.proposed, let who = job.approvalName {
                    if !memberView { entries.append(Entry(at: at, order: 2, content: .system(approvalLine(job, who: who, local: local, at: at)))) }
                    continue
                }
                // Members never act on a Task (Go and Start run on the Owner's Mac): they see its card.
                if memberView { continue }
                if let s = job.suggestion {
                    add(offerMessage(job, target: s, local: local, threads: threads, at: at, place: RoomPlaces.chip(for: job, chosen: feed.jobPlace[job.id])), order: 2)
                } else {
                    entries.append(Entry(at: at, order: 2, content: .system(noDuckLine(job, local: local, at: at, place: RoomPlaces.chip(for: job, chosen: feed.jobPlace[job.id])))))
                }
            }
        }
        // "Make task" refused: no job exists yet, so the line hangs off the message.
        for (key, l) in feed.jobLocal where key.hasPrefix("msg:") {
            guard let e = l.error else { continue }
            let id = String(key.dropFirst(4))
            let at = postsById[id]?.post.at ?? 0
            entries.append(Entry(at: at, order: 2, content: .system(RoomSystemLine(id: "jobmsg:" + id, at: at, text: "Not made a task", jobId: nil, buttons: [], error: e))))
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

    static func offerMessage(_ job: RoomTask, target s: RoomTaskTarget, local: RoomTaskLocal?, threads: [String: RoomThread], at: Int64, place: RoomPlaceChip? = nil) -> RoomMessage {
        let a = RoomMessageAuthor.duck(threads[s.sessionId], sessionId: s.sessionId, fallbackName: s.title, agent: nil)
        let words = s.pitch.map { "I can take this \u{2014} I \($0)." } ?? "I can take this."
        var note: String?
        var buttons = [
            RoomTaskButton(id: "go", title: "Go", role: .primary, action: .go(sessionId: s.sessionId)),
            RoomTaskButton(id: "note", title: "Not now", role: .secondary, action: .drop),
        ]
        if let p = local?.pending {
            switch p {
            case .go: note = "Handing over\u{2026}"; buttons = []
            case .newThread: note = "Starting a new duck\u{2026}"; buttons = []
            case .drop, .allow, .deny, .reroute, .approve: break
            }
        }
        let others = job.candidates.filter { $0.sessionId != s.sessionId }
        return RoomMessage(
            id: "job:\(job.id):offer", at: at, author: a,
            parts: [.offer(RoomOffer(jobId: job.id, text: words, buttons: buttons, candidates: others, note: note, error: local?.error, isClaim: false, place: place))])
    }

    static func claimMessage(_ job: RoomTask, claim: RoomTaskClaim, local: RoomTaskLocal?, threads: [String: RoomThread], at: Int64, place: RoomPlaceChip? = nil) -> RoomMessage? {
        let a = RoomMessageAuthor.duck(threads[claim.sessionId], sessionId: claim.sessionId, fallbackName: claim.title, agent: nil)
        var words = "I\u{2019}d like to take \u{201C}\(shorten(job.text, 80))\u{201D} after this"
        if var e = claim.eta?.trimmingCharacters(in: .whitespaces), !e.isEmpty {
            if e.hasPrefix("~") { e.removeFirst(); e = e.trimmingCharacters(in: .whitespaces) }
            words += " \u{2014} about \(e)"
        }
        words += "."
        var buttons = [
            RoomTaskButton(id: "allow", title: "Allow", role: .primary, action: .allow),
            RoomTaskButton(id: "deny", title: "No", role: .secondary, action: .deny),
        ]
        var note: String?
        if claim.status == .allowed { buttons = []; note = "Allowed" }
        else if let p = local?.pending, p == .allow || p == .deny { buttons = []; note = p == .allow ? "Allowed" : "Okay, not now" }
        return RoomMessage(
            id: "job:\(job.id):claim", at: at, author: a,
            parts: [.offer(RoomOffer(jobId: job.id, text: words, buttons: buttons, candidates: [], note: note, error: local?.error, isClaim: true, place: place))])
    }

    /// "Aarav asked for this task \u{2014}  [Approve] [Drop]": the Owner lets a Member's Task go ahead, or drops it.
    static func approvalLine(_ job: RoomTask, who: String, local: RoomTaskLocal?, at: Int64) -> RoomSystemLine {
        var buttons = [
            RoomTaskButton(id: "approve", title: "Approve", role: .primary, action: .approve),
            RoomTaskButton(id: "note", title: "Drop", role: .quiet, action: .drop),
        ]
        var note: String?
        if local?.pending == .approve { buttons = []; note = "Approving\u{2026}" }
        return RoomSystemLine(
            id: "job:\(job.id):approve", at: at, text: "\(who) asked for this task \u{2014}", jobId: job.id, buttons: buttons,
            error: local?.error, note: note)
    }

    static func noDuckLine(_ job: RoomTask, local: RoomTaskLocal?, at: Int64, place: RoomPlaceChip? = nil) -> RoomSystemLine {
        var buttons = [
            RoomTaskButton(id: "start", title: "Start a new duck", role: .secondary, action: .newThread),
            RoomTaskButton(id: "note", title: "Drop", role: .quiet, action: .drop),
        ]
        var note: String?
        if local?.pending == .newThread { buttons = []; note = "Starting a new duck\u{2026}" }
        return RoomSystemLine(id: "job:\(job.id):sys", at: at, text: "No duck fits this task \u{2014}", jobId: job.id, buttons: buttons, error: local?.error, note: note, place: place)
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
