import Foundation

// Room Tasks: a person's room message that is work. Squeak never chats: its only words are
// one quiet action line under the message and, when a running thread asks to take a job, a card in Now. Nothing is taken
// or started without the person's explicit OK (Go / Allow). Everything here is read leniently: a host without `jobs`
// sends none and the room shows nothing new.

/// A Task's state: waiting (not taken up), working (a Duck has it), blocked (its turn did not finish), done, dropped.
public enum RoomTaskState: String, Sendable, Equatable {
    case waiting, working, blocked, done, dropped

    /// The word a Task shows.
    public var label: String {
        switch self {
        case .waiting: "Waiting"
        case .working: "Working"
        case .blocked: "Blocked"
        case .done: "Done"
        case .dropped: "Dropped"
        }
    }
}

/// One Room message a Task carries (the person can trim these before the Task is sent).
public struct RoomTaskMessage: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var author: String
    public var text: String
    public var at: Int64
    public init(id: String, author: String, text: String, at: Int64 = 0) {
        self.id = id; self.author = author; self.text = text; self.at = at
    }
    private enum CodingKeys: String, CodingKey { case id, author, text, at }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        author = (try? c.decode(String.self, forKey: .author)) ?? ""
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        at = c.ms(.at) ?? 0
    }
}

public struct RoomTaskTarget: Sendable, Equatable, Decodable {
    public var sessionId: String
    public var title: String
    public var reason: String
    /// "working" or "idle" (anything else reads as idle).
    public var state: String
    /// First person, from the host: "worked on the control bar an hour ago" (the duck says "I <pitch>"). Nil from an older host.
    public var pitch: String?
    /// The Duck itself (a Duck outlives its chats); nil from an older host.
    public var duckId: String?
    public init(sessionId: String, title: String, reason: String = "", state: String = "idle", pitch: String? = nil, duckId: String? = nil) {
        self.sessionId = sessionId; self.title = title; self.reason = reason; self.state = state; self.pitch = pitch; self.duckId = duckId
    }
    private enum CodingKeys: String, CodingKey { case sessionId, title, reason, state, pitch, duckId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        duckId = (try? c.decode(String.self, forKey: .duckId)).flatMap { $0.isEmpty ? nil : $0 }
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        state = (try? c.decode(String.self, forKey: .state)) ?? "idle"
        pitch = (try? c.decode(String.self, forKey: .pitch)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
    }
}

/// What the decider chose for a Task (or the person chose after): the words of the Room's one routing line.
public struct RoomTaskRouting: Sendable, Equatable, Decodable {
    /// "duck", "hatch" or "wait" (anything else reads as hatch).
    public var kind: String
    public var duckId: String?
    public var name: String?
    public var reason: String
    public var byPerson: Bool
    public init(kind: String, duckId: String? = nil, name: String? = nil, reason: String = "", byPerson: Bool = false) {
        self.kind = kind; self.duckId = duckId; self.name = name; self.reason = reason; self.byPerson = byPerson
    }
    private enum CodingKeys: String, CodingKey { case kind, duckId, name, reason, by }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "hatch"
        duckId = (try? c.decode(String.self, forKey: .duckId)).flatMap { $0.isEmpty ? nil : $0 }
        name = (try? c.decode(String.self, forKey: .name)).flatMap { $0.isEmpty ? nil : $0 }
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        byPerson = ((try? c.decode(String.self, forKey: .by)) ?? "") == "person"
    }
}

public enum RoomClaimStatus: String, Sendable, Equatable { case asking, allowed, denied }

public struct RoomTaskClaim: Sendable, Equatable, Decodable {
    public var sessionId: String
    public var title: String
    public var eta: String?
    public var at: Int64
    public var status: RoomClaimStatus
    public init(sessionId: String, title: String, eta: String? = nil, at: Int64 = 0, status: RoomClaimStatus = .asking) {
        self.sessionId = sessionId; self.title = title; self.eta = eta; self.at = at; self.status = status
    }
    private enum CodingKeys: String, CodingKey { case sessionId, title, eta, at, status }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        eta = (try? c.decode(String.self, forKey: .eta)).flatMap { $0.isEmpty ? nil : $0 }
        at = c.ms(.at) ?? 0
        // An unknown status is not asking: a card must never offer Allow for something it cannot read.
        status = (try? c.decode(String.self, forKey: .status)).flatMap(RoomClaimStatus.init(rawValue:)) ?? .denied
    }
}

public struct RoomTaskHandedTo: Sendable, Equatable, Decodable {
    public var sessionId: String
    public var title: String
    public var turnId: String?
    public var newThread: Bool
    public init(sessionId: String, title: String, turnId: String? = nil, newThread: Bool = false) {
        self.sessionId = sessionId; self.title = title; self.turnId = turnId; self.newThread = newThread
    }
    private enum CodingKeys: String, CodingKey { case sessionId, title, turnId, newThread }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        turnId = (try? c.decode(String.self, forKey: .turnId)).flatMap { $0.isEmpty ? nil : $0 }
        newThread = (try? c.decode(Bool.self, forKey: .newThread)) ?? false
    }
}

/// Where a job's work happens: an existing stream of the pond, or a new one on a branch the host will make.
public enum RoomTaskPlace: Sendable, Equatable, Decodable {
    case stream(workspaceId: String, branch: String)
    case new(branch: String)

    private enum CodingKeys: String, CodingKey { case kind, workspaceId, branch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let branch = try c.decode(String.self, forKey: .branch)
        switch try c.decode(String.self, forKey: .kind) {
        case "stream": self = .stream(workspaceId: try c.decode(String.self, forKey: .workspaceId), branch: branch)
        case "new": self = .new(branch: branch)
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "kind")
        }
    }

    public var branch: String {
        switch self { case .stream(_, let b), .new(let b): b }
    }

    /// The strict body shape the host checks: `{kind, workspaceId, branch}` or `{kind, branch}`.
    public var json: NativeJSON {
        switch self {
        case .stream(let w, let b): .object(["kind": .string("stream"), "workspaceId": .string(w), "branch": .string(b)])
        case .new(let b): .object(["kind": .string("new"), "branch": .string(b)])
        }
    }
}

public struct RoomTask: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var messageId: String
    public var text: String
    /// One line.
    public var title: String
    public var state: RoomTaskState
    /// Only suggested so far: the person has not taken it up.
    public var proposed: Bool
    public var parentTaskId: String?
    /// The Room messages since the previous Task (at most 2 h) the Task carries.
    public var discussion: [RoomTaskMessage]
    public var suggestion: RoomTaskTarget?
    public var candidates: [RoomTaskTarget]
    public var routing: RoomTaskRouting?
    /// Chosen by the host; absent in a plain-folder pond (no streams) and from an older host.
    public var place: RoomTaskPlace?
    public var claim: RoomTaskClaim?
    public var handedTo: RoomTaskHandedTo?
    /// How it ended: the Duck's first sentence.
    public var result: String?
    /// Set while the Task waits for the Owner's approval: the name of the Member who made it (their start permission is off).
    /// The Owner's host says `approval { by, name }`; a Member's page says `needsApproval { name }`.
    public var approvalName: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(
        id: String, messageId: String, text: String = "", title: String? = nil, state: RoomTaskState = .waiting, proposed: Bool = false,
        parentTaskId: String? = nil, discussion: [RoomTaskMessage] = [], suggestion: RoomTaskTarget? = nil,
        candidates: [RoomTaskTarget] = [], claim: RoomTaskClaim? = nil, handedTo: RoomTaskHandedTo? = nil, result: String? = nil,
        createdAt: Int64 = 0, updatedAt: Int64 = 0, place: RoomTaskPlace? = nil, routing: RoomTaskRouting? = nil, approvalName: String? = nil
    ) {
        self.place = place; self.routing = routing; self.approvalName = approvalName
        self.id = id; self.messageId = messageId; self.text = text; self.title = title ?? RoomTasks.title(of: text)
        self.state = state; self.proposed = proposed; self.parentTaskId = parentTaskId; self.discussion = discussion
        self.suggestion = suggestion
        self.candidates = candidates; self.claim = claim; self.handedTo = handedTo; self.result = result
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, messageId, text, title, state, proposed, parentTaskId, discussion, suggestion, candidates, routing, place, claim, handedTo, result
        case createdAt, updatedAt, approval, needsApproval
    }
    private struct Approver: Decodable { var name: String }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A Task with no id, message or readable state cannot be placed or acted on; the page drops it.
        id = try c.decode(String.self, forKey: .id)
        messageId = try c.decode(String.self, forKey: .messageId)
        guard let s = (try? c.decode(String.self, forKey: .state)).flatMap(RoomTaskState.init(rawValue:)) else {
            throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "state")
        }
        state = s
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? RoomTasks.title(of: text)
        proposed = (try? c.decode(Bool.self, forKey: .proposed)) ?? false
        parentTaskId = (try? c.decode(String.self, forKey: .parentTaskId)).flatMap { $0.isEmpty ? nil : $0 }
        discussion = ((try? c.decode([Failable<RoomTaskMessage>].self, forKey: .discussion)) ?? []).compactMap(\.value)
        suggestion = try? c.decode(RoomTaskTarget.self, forKey: .suggestion)
        candidates = ((try? c.decode([Failable<RoomTaskTarget>].self, forKey: .candidates)) ?? []).compactMap(\.value)
        routing = try? c.decode(RoomTaskRouting.self, forKey: .routing)
        place = try? c.decode(RoomTaskPlace.self, forKey: .place)
        claim = try? c.decode(RoomTaskClaim.self, forKey: .claim)
        handedTo = try? c.decode(RoomTaskHandedTo.self, forKey: .handedTo)
        result = (try? c.decode(String.self, forKey: .result)).flatMap { $0.isEmpty ? nil : $0 }
        let approver = (try? c.decode(Approver.self, forKey: .approval)) ?? (try? c.decode(Approver.self, forKey: .needsApproval))
        approvalName = approver.map { $0.name.trimmingCharacters(in: .whitespaces).isEmpty ? "A Member" : $0.name }
        createdAt = c.ms(.createdAt) ?? 0
        updatedAt = c.ms(.updatedAt) ?? createdAt
    }
}

extension KeyedDecodingContainer {
    /// A millisecond stamp that may arrive as an integer or a float.
    fileprivate func ms(_ key: Key) -> Int64? {
        if let n = try? decode(Int64.self, forKey: key) { return n }
        if let d = try? decode(Double.self, forKey: key) { return Int64(d) }
        return nil
    }
}

/// What the person pressed. The body is strict: exactly `action` and, for Go, an optional `sessionId`.
public enum RoomTaskAction: Sendable, Equatable {
    case go(sessionId: String?)
    case newThread
    case drop
    case allow
    case deny
    /// Give the waiting Task to another Duck (nil: a new one); nothing starts until the host's line or Go does.
    case reroute(duckId: String?)
    /// The Owner lets a Member's Task go ahead (it waited for approval).
    case approve

    public var body: NativeJSON { body(place: nil) }

    /// The request body; `place` and `include` (the Room messages kept after the person's trim) ride only on Go, a new duck and
    /// Allow (the host refuses them elsewhere).
    public func body(place: RoomTaskPlace?, include: [String]? = nil) -> NativeJSON {
        var o: [String: NativeJSON]
        switch self {
        case .go(let id):
            o = ["action": .string("go")]
            if let id { o["sessionId"] = .string(id) }
        case .newThread: o = ["action": .string("new")]
        case .drop: return .object(["action": .string("drop")])
        case .allow: o = ["action": .string("allow")]
        case .deny: return .object(["action": .string("deny")])
        case .reroute(let id):
            var r: [String: NativeJSON] = ["action": .string("reroute")]
            if let id { r["duckId"] = .string(id) }
            return .object(r)
        case .approve: return .object(["action": .string("approve")])
        }
        if let place { o["place"] = place.json }
        if let include { o["messageIds"] = .array(include.map { .string($0) }) }
        return .object(o)
    }
}

public enum RoomTasks {
    /// A Task's one-line title from its text: the first line, at most 60 characters, no closing full stop.
    public static func title(of text: String) -> String {
        let first = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        var t = first.trimmingCharacters(in: .whitespacesAndNewlines)
        while let l = t.last, ".!?".contains(l) { t.removeLast() }
        if t.count > 60 { t = String(t.prefix(59)) + "\u{2026}" }
        return t.isEmpty ? "New task" : t
    }

    /// The sentence to show when the host refuses (a 409 carries its own) or cannot be reached.
    public static func refusal(_ error: Error) -> String {
        if let e = error as? NativeHostError {
            if case .http(_, let m?) = e, !m.trimmingCharacters(in: .whitespaces).isEmpty { return m }
            return e.reason
        }
        return "That did not go through. Try again."
    }

    /// Turn row ids are `<sessionId>:<turnId>`; a host may send either spelling.
    public static func turnRowId(_ h: RoomTaskHandedTo) -> String? {
        guard let t = h.turnId else { return nil }
        return t.contains(":") ? t : "\(h.sessionId):\(t)"
    }
}

// MARK: - Local state (optimistic, reconciled by the job's id)

public struct RoomTaskLocal: Sendable, Equatable {
    /// An action sent and not yet answered: the line shows it at once.
    public var pending: RoomTaskAction?
    /// The target's title when the pending action is Go, so the line can say "Handing to X".
    public var pendingTitle: String?
    /// A refusal or failure, shown inline under the line until the job next changes.
    public var error: String?
    /// A Member's "Make task" sent to the Owner's Mac and not yet seen as a Task: the message stops offering it.
    public var queued: Bool
    public init(pending: RoomTaskAction? = nil, pendingTitle: String? = nil, error: String? = nil, queued: Bool = false) {
        self.pending = pending; self.pendingTitle = pendingTitle; self.error = error; self.queued = queued
    }
}

// MARK: - The action line

public struct RoomTaskButton: Sendable, Equatable, Identifiable {
    public enum Role: Sendable, Equatable { case primary, secondary, quiet }
    public var id: String
    public var title: String
    public var role: Role
    public var action: RoomTaskAction
}

/// The one quiet line under a person's message. Pure: the view only draws it.
public struct RoomTaskLine: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        case suggestion, newThread, handing, running, done, blocked
        /// Dismissed: the line collapses in place (the row stays in the list at zero height, so nothing jumps).
        case collapsed
        /// "Make task" was refused or did not go; there is no job yet.
        case makeFailed
    }
    public enum Mark: Sendable, Equatable { case none, working, failed }

    public var id: String
    public var messageId: String
    public var jobId: String?
    public var kind: Kind
    public var mark: Mark
    /// "Looks like a task →", "Handed to", "Done ·": the words before the target.
    public var lead: String
    public var target: RoomTaskTarget?
    public var targetTitle: String?
    public var candidates: [RoomTaskTarget]
    public var buttons: [RoomTaskButton]
    /// Done: the outcome sentence, which links to `turnRowId`.
    public var detail: String?
    public var turnRowId: String?
    public var error: String?

    public var isCollapsed: Bool { kind == .collapsed }

    /// The VoiceOver sentence.
    public var spoken: String {
        var s = lead
        if let t = targetTitle { s += " " + t }
        if let d = detail { s += " " + d }
        if let e = error { s += ". " + e }
        return s
    }
}

extension RoomTasks {
    public static let suggestionLead = "Looks like a task \u{2192}"
    public static let taskLead = "Task \u{2192}"

    public static func line(for job: RoomTask, local: RoomTaskLocal? = nil) -> RoomTaskLine {
        func base(_ kind: RoomTaskLine.Kind, mark: RoomTaskLine.Mark = .none, lead: String) -> RoomTaskLine {
            RoomTaskLine(
                id: "job:" + job.id, messageId: job.messageId, jobId: job.id, kind: kind, mark: mark, lead: lead, target: nil,
                targetTitle: nil, candidates: [], buttons: [], detail: nil, turnRowId: nil, error: local?.error)
        }
        // An action in flight: shown at once, reconciled when the host's Task arrives.
        if let p = local?.pending, job.state == .waiting {
            switch p {
            case .drop: return base(.collapsed, lead: "")
            case .go:
                var l = base(.handing, mark: .working, lead: "Handing to")
                l.targetTitle = local?.pendingTitle ?? job.suggestion?.title
                return l
            case .newThread: return base(.handing, mark: .working, lead: "Starting a new duck")
            case .allow, .deny, .reroute, .approve: break  // a claim's answer shows on the claim card; the line keeps its words
            }
        }
        switch job.state {
        case .dropped: return base(.collapsed, lead: "")
        case .waiting:
            let lead = job.proposed ? suggestionLead : taskLead
            if let s = job.suggestion {
                var l = base(.suggestion, lead: lead)
                l.target = s; l.targetTitle = s.title
                // Other threads the person may pick instead (never the suggestion twice).
                l.candidates = job.candidates.filter { $0.sessionId != s.sessionId }
                l.buttons = [
                    RoomTaskButton(id: "go", title: "Go", role: .primary, action: .go(sessionId: s.sessionId)),
                    RoomTaskButton(id: "new", title: "New duck", role: .secondary, action: .newThread),
                    RoomTaskButton(id: "note", title: "Drop", role: .quiet, action: .drop),
                ]
                return l
            }
            var l = base(.newThread, lead: lead)
            l.targetTitle = "new duck"
            l.candidates = job.candidates
            l.buttons = [
                RoomTaskButton(id: "start", title: "Start", role: .primary, action: .newThread),
                RoomTaskButton(id: "note", title: "Drop", role: .quiet, action: .drop),
            ]
            return l
        case .working:
            var l = base(.running, mark: .working, lead: "")
            let t = job.handedTo?.title ?? ""
            l.targetTitle = t.isEmpty ? "A duck" : t
            l.lead = "is on it"
            return l
        case .done:
            var l = base(.done, lead: "Done")
            l.detail = job.result
            l.turnRowId = job.handedTo.flatMap(turnRowId)
            return l
        case .blocked:
            var l = base(.blocked, mark: .failed, lead: "Didn\u{2019}t finish")
            l.turnRowId = job.handedTo.flatMap(turnRowId)
            return l
        }
    }

    /// The line for a message that has no job but whose "Make task" did not go.
    public static func makeFailedLine(messageId: String, error: String) -> RoomTaskLine {
        RoomTaskLine(
            id: "jobmsg:" + messageId, messageId: messageId, jobId: nil, kind: .makeFailed, mark: .failed, lead: "Not made a task", target: nil,
            targetTitle: nil, candidates: [], buttons: [], detail: nil, turnRowId: nil, error: error)
    }

    /// The job a message carries (the newest one by creation, then id).
    public static func job(for messageId: String, in jobs: [RoomTask]) -> RoomTask? {
        jobs.last { $0.messageId == messageId }
    }

    /// "Make task" is offered on a person's room message that has no live Task (a dropped one may be made again, a suggestion taken up).
    public static func canMakeTask(_ row: RoomRow, jobs: [RoomTask]) -> Bool {
        guard row.post.author.kind == .person, row.post.level == .room, !row.pending, !row.failed, row.post.seq > 0 else { return false }
        guard let j = job(for: row.post.id, in: jobs) else { return true }
        return j.state == .dropped || j.proposed
    }

    // MARK: Claims (Now)

    /// A thread asking to take a job: a card in Now, shown only while it is asking and the job is still open.
    public struct ClaimCard: Sendable, Equatable, Identifiable {
        public var id: String { jobId }
        public var jobId: String
        public var sessionId: String
        public var title: String
        public var agent: String?
        public var jobText: String
        /// "after this turn, ~5 min".
        public var when: String
        public var at: Int64
    }

    public static func claims(jobs: [RoomTask], local: [String: RoomTaskLocal] = [:], threads: [RoomThread] = []) -> [ClaimCard] {
        var out: [ClaimCard] = []
        for j in jobs where j.state == .waiting {
            guard let c = j.claim, c.status == .asking else { continue }
            if let p = local[j.id]?.pending, p == .allow || p == .deny { continue }
            let title = c.title.isEmpty ? (threads.first { $0.sessionId == c.sessionId }?.title ?? "A duck") : c.title
            out.append(ClaimCard(
                jobId: j.id, sessionId: c.sessionId, title: title, agent: threads.first { $0.sessionId == c.sessionId }?.agent,
                jobText: j.text, when: when(eta: c.eta), at: c.at))
        }
        // Oldest ask first, then id: a card never jumps when another one arrives.
        return out.sorted { ($0.at, $0.jobId) < ($1.at, $1.jobId) }
    }

    public static func when(eta: String?) -> String {
        guard var e = eta?.trimmingCharacters(in: .whitespaces), !e.isEmpty else { return "after this turn" }
        if !e.hasPrefix("~") { e = "~" + e }
        return "after this turn, " + e
    }
}

// MARK: - Place (where a job's work happens)

/// The chip under an offer: "\u{2192} on <branch>" or "\u{2192} new stream <branch>", with what Change may pick.
public struct RoomPlaceChip: Sendable, Equatable {
    public var text: String
    public var place: RoomTaskPlace
    /// The person picked it here (it differs from what the host chose).
    public var changed: Bool
    /// What "New stream\u{2026}" starts with.
    public var prefill: String
}

/// One stream of the pond the person may pick.
public struct RoomStreamChoice: Sendable, Equatable, Identifiable {
    public var id: String { workspaceId }
    public var workspaceId: String
    public var branch: String
    public var createdAt: Date?
    public init(workspaceId: String, branch: String, createdAt: Date? = nil) {
        self.workspaceId = workspaceId; self.branch = branch; self.createdAt = createdAt
    }
}

public enum RoomPlaceMenuItem: Sendable, Equatable {
    case stream(RoomStreamChoice, selected: Bool)
    /// "New stream\u{2026}": opens an editable branch name, prefilled.
    case newStream(prefill: String, selected: Bool)
}

public enum RoomPlaces {
    /// The place that will be sent: the person's pick, else the host's. Nil hides the chip (a folder pond has no streams).
    public static func effective(_ job: RoomTask, chosen: RoomTaskPlace?) -> RoomTaskPlace? { chosen ?? job.place }

    public static func chipText(_ place: RoomTaskPlace) -> String {
        switch place {
        case .stream(_, let b): "\u{2192} on \(b)"
        case .new(let b): "\u{2192} new stream \(b)"
        }
    }

    public static func chip(for job: RoomTask, chosen: RoomTaskPlace?) -> RoomPlaceChip? {
        guard let p = effective(job, chosen: chosen) else { return nil }
        return RoomPlaceChip(text: chipText(p), place: p, changed: chosen != nil && chosen != job.place,
            prefill: suggestedBranch(job: job, chosen: chosen))
    }

    /// The pond's open streams for the menu, newest first (a stream with no date after the dated ones, then by branch).
    public static func streams(_ workspaces: [NativeWorkspace], projectId: String) -> [RoomStreamChoice] {
        workspaces.filter { $0.projectId == projectId && $0.state != "archived" }
            .map { RoomStreamChoice(workspaceId: $0.id, branch: $0.branch, createdAt: $0.createdAt) }
            .sorted {
                switch ($0.createdAt, $1.createdAt) {
                case (let a?, let b?) where a != b: return a > b
                case (_?, nil): return true
                case (nil, _?): return false
                default: return $0.branch < $1.branch
                }
            }
    }

    /// The streams, then "New stream\u{2026}". There is no "Main": a pond with no streams has no place at all.
    public static func menu(streams: [RoomStreamChoice], current: RoomTaskPlace?, prefill: String) -> [RoomPlaceMenuItem] {
        var items: [RoomPlaceMenuItem] = streams.map { s in
            var on = false
            if case .stream(let w, _)? = current, w == s.workspaceId { on = true }
            return .stream(s, selected: on)
        }
        var onNew = false
        if case .new? = current { onNew = true }
        items.append(.newStream(prefill: prefill, selected: onNew))
        return items
    }

    /// The new-stream field's starting text: a new branch already chosen, else the host's suggestion, else one from the job's words.
    public static func suggestedBranch(job: RoomTask, chosen: RoomTaskPlace?) -> String {
        if case .new(let b)? = chosen { return b }
        if case .new(let b)? = job.place { return b }
        return slug(job.text)
    }

    /// "Fix the login redirect" -> "fix-the-login-redirect" (at most 5 words, 40 characters).
    public static func slug(_ text: String) -> String {
        let words = text.lowercased().split(whereSeparator: { !($0.isLetter || $0.isNumber) }).prefix(5)
        return String(words.joined(separator: "-").prefix(40)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    /// A sentence when the name cannot be a new stream's branch (git's `check-ref-format` rules, plus a name a stream already has); nil when fine.
    public static func branchProblem(_ raw: String, taken: [String]) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Give the stream a name." }
        if name.count > 200 { return "That name is too long." }
        let bad = "That isn\u{2019}t a name git accepts."
        if name == "@" || name.hasPrefix("/") || name.hasSuffix("/") || name.hasSuffix(".") || name.contains("//") || name.contains("..") || name.contains("@{") {
            return bad
        }
        if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || " ~^:?*[\\".unicodeScalars.contains($0) }) { return bad }
        for part in name.split(separator: "/") where part.hasPrefix(".") || part.hasSuffix(".lock") { return bad }
        if taken.contains(name) { return "A stream is already on \(name)." }
        return nil
    }
}

// MARK: - The Task in the Room

/// One Task as the Room draws it: its title, its state, the Room messages it carries and what the person can do.
/// The routing line and what its one tap offers.
public struct RoomRoutingLine: Sendable, Equatable {
    public struct Choice: Sendable, Equatable, Identifiable {
        public var id: String { duckId ?? "new" }
        /// nil = a new Duck.
        public var duckId: String?
        public var name: String
    }
    public var text: String
    /// Other Ducks to send it to, then a new one; empty once the Task is under way (the line stays, the tap goes).
    public var choices: [Choice]
}

public struct RoomTaskCard: Sendable, Equatable, Identifiable {
    public var id: String { "task:" + taskId }
    public var taskId: String
    public var title: String
    public var state: RoomTaskState
    /// "Waiting", "Working", ... (a suggestion nobody took up says "Suggested").
    public var stateLabel: String
    /// "Part of <parent title>" when the Task has a parent the Room knows.
    public var parentTitle: String?
    /// Done: the Duck's one sentence.
    public var result: String?
    /// The duck's tab the card opens (the Duck that has the Task).
    public var opens: String?
    /// The turn of that Duck's chat the Task began in (the bare turn id); nil until the host names it.
    public var opensTurn: String? = nil
    /// The messages the person may include or leave out (never the one that made the Task); empty once it is sent.
    public var discussion: [RoomTaskMessage]
    public var excluded: Set<String>
    public var canDrop: Bool
    public var error: String?
    /// The one quiet routing line ("\u{2192} given to Pixel (related to icon work)"); nil until the decider has chosen.
    public var routing: RoomRoutingLine? = nil
    /// Waiting for the Owner's approval: who asked. The label says whose turn it is.
    public var approvalName: String? = nil

    public var trimmable: Bool { !discussion.isEmpty }
    /// "3 of 5 messages".
    public var discussionSummary: String {
        let n = discussion.count
        let kept = discussion.filter { !excluded.contains($0.id) }.count
        if kept == n { return n == 1 ? "1 message" : "\(n) messages" }
        return kept == 0 ? "no messages" : "\(kept) of \(n) messages"
    }
    public var spoken: String { "Task: \(title). \(stateLabel)" + (result.map { ". \($0)" } ?? "") }
}

extension RoomTasks {
    /// The card for a Task; nil for a dropped one (it leaves the Room, the row stays put).
    public static func card(
        for task: RoomTask, among tasks: [RoomTask], local: RoomTaskLocal? = nil, excluded: Set<String> = [], memberView: Bool = false
    ) -> RoomTaskCard? {
        if task.state == .dropped { return nil }
        if local?.pending == .drop { return nil }
        let carried = task.state == .waiting ? task.discussion.filter { $0.id != task.messageId } : []
        let approval = task.state == .waiting && !task.proposed ? task.approvalName : nil
        return RoomTaskCard(
            taskId: task.id, title: task.title, state: task.state,
            stateLabel: approval != nil ? approvalLabel(memberView: memberView) : task.proposed && task.state == .waiting ? "Suggested" : task.state.label,
            parentTitle: task.parentTaskId.flatMap { p in tasks.first { $0.id == p }?.title },
            result: task.state == .done ? task.result : nil,
            opens: task.handedTo?.sessionId,
            opensTurn: task.handedTo.flatMap { h in h.turnId.map { RoomTurnId.bare($0, session: h.sessionId) } },
            discussion: carried, excluded: excluded.intersection(carried.map(\.id)),
            canDrop: task.state != .done, error: local?.error, routing: routingLine(for: task), approvalName: approval)
    }

    /// "\u{2192} given to Pixel (related to icon work)"; a new Duck and a wait read the same way.
    public static func routingLine(for task: RoomTask) -> RoomRoutingLine? {
        guard let r = task.routing, task.state != .dropped else { return nil }
        let why = r.reason.isEmpty ? "" : " (\(r.reason))"
        let text: String
        switch r.kind {
        case "duck": text = "\u{2192} given to \(r.name ?? task.suggestion?.title ?? "a duck")\(why)"
        case "wait": text = "\u{2192} waiting\(why)"
        default: text = "\u{2192} new duck\(why)"
        }
        guard task.state == .waiting else { return RoomRoutingLine(text: text, choices: []) }
        var choices = task.candidates.compactMap { c -> RoomRoutingLine.Choice? in
            guard let id = c.duckId, id != r.duckId else { return nil }
            return .init(duckId: id, name: c.title)
        }
        if r.kind != "hatch" { choices.append(.init(duckId: nil, name: "A new duck")) }
        return RoomRoutingLine(text: text, choices: choices)
    }

    /// Whose turn a Member's Task is: the Owner's (they approve it), or what the Member sees while they wait.
    public static func approvalLabel(memberView: Bool) -> String { memberView ? "Waiting for the Owner\u{2019}s approval" : "Needs your approval" }

    /// The messages to send with Go, a new duck or Allow: all the Task carries minus the person's trim; nil when nothing
    /// was trimmed (the host then sends what it carries).
    public static func messageIdsToSend(for task: RoomTask, excluded: Set<String>) -> [String]? {
        let out = excluded.intersection(task.discussion.map(\.id))
        if out.isEmpty { return nil }
        return task.discussion.map(\.id).filter { !out.contains($0) }
    }
}
