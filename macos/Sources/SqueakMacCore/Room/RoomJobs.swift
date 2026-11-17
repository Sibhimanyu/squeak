import Foundation

// Room jobs (host contract CONTRACT-jobs.md): a person's room message that is work. Squeak never chats: its only words are
// one quiet action line under the message and, when a running thread asks to take a job, a card in Now. Nothing is taken
// or started without the person's explicit OK (Go / Allow). Everything here is read leniently: a host without `jobs`
// sends none and the room shows nothing new.

public enum RoomJobStatus: String, Sendable, Equatable { case suggested, dismissed, handed, running, done, failed }

public struct RoomJobTarget: Sendable, Equatable, Decodable {
    public var sessionId: String
    public var title: String
    public var reason: String
    /// "working" or "idle" (anything else reads as idle).
    public var state: String
    public init(sessionId: String, title: String, reason: String = "", state: String = "idle") {
        self.sessionId = sessionId; self.title = title; self.reason = reason; self.state = state
    }
    private enum CodingKeys: String, CodingKey { case sessionId, title, reason, state }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        state = (try? c.decode(String.self, forKey: .state)) ?? "idle"
    }
}

public enum RoomClaimStatus: String, Sendable, Equatable { case asking, allowed, denied }

public struct RoomJobClaim: Sendable, Equatable, Decodable {
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

public struct RoomJobHandedTo: Sendable, Equatable, Decodable {
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

public struct RoomJob: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var messageId: String
    public var text: String
    public var status: RoomJobStatus
    public var suggestion: RoomJobTarget?
    public var candidates: [RoomJobTarget]
    public var claim: RoomJobClaim?
    public var handedTo: RoomJobHandedTo?
    public var outcomeText: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(
        id: String, messageId: String, text: String = "", status: RoomJobStatus = .suggested, suggestion: RoomJobTarget? = nil,
        candidates: [RoomJobTarget] = [], claim: RoomJobClaim? = nil, handedTo: RoomJobHandedTo? = nil, outcomeText: String? = nil,
        createdAt: Int64 = 0, updatedAt: Int64 = 0
    ) {
        self.id = id; self.messageId = messageId; self.text = text; self.status = status; self.suggestion = suggestion
        self.candidates = candidates; self.claim = claim; self.handedTo = handedTo; self.outcomeText = outcomeText
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, messageId, text, status, suggestion, candidates, claim, handedTo, outcomeText, createdAt, updatedAt
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A job with no id, message or readable status cannot be placed or acted on; the page drops it.
        id = try c.decode(String.self, forKey: .id)
        messageId = try c.decode(String.self, forKey: .messageId)
        guard let s = (try? c.decode(String.self, forKey: .status)).flatMap(RoomJobStatus.init(rawValue:)) else {
            throw DecodingError.dataCorruptedError(forKey: .status, in: c, debugDescription: "status")
        }
        status = s
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        suggestion = try? c.decode(RoomJobTarget.self, forKey: .suggestion)
        candidates = ((try? c.decode([Failable<RoomJobTarget>].self, forKey: .candidates)) ?? []).compactMap(\.value)
        claim = try? c.decode(RoomJobClaim.self, forKey: .claim)
        handedTo = try? c.decode(RoomJobHandedTo.self, forKey: .handedTo)
        outcomeText = (try? c.decode(String.self, forKey: .outcomeText)).flatMap { $0.isEmpty ? nil : $0 }
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
public enum RoomJobAction: Sendable, Equatable {
    case go(sessionId: String?)
    case newThread
    case dismiss
    case allow
    case deny

    public var body: NativeJSON {
        switch self {
        case .go(let id):
            var o: [String: NativeJSON] = ["action": .string("go")]
            if let id { o["sessionId"] = .string(id) }
            return .object(o)
        case .newThread: return .object(["action": .string("new")])
        case .dismiss: return .object(["action": .string("dismiss")])
        case .allow: return .object(["action": .string("allow")])
        case .deny: return .object(["action": .string("deny")])
        }
    }
}

public enum RoomJobs {
    /// The sentence to show when the host refuses (a 409 carries its own) or cannot be reached.
    public static func refusal(_ error: Error) -> String {
        if let e = error as? NativeHostError {
            if case .http(_, let m?) = e, !m.trimmingCharacters(in: .whitespaces).isEmpty { return m }
            return e.reason
        }
        return "That did not go through. Try again."
    }

    /// Turn row ids are `<sessionId>:<turnId>`; a host may send either spelling.
    public static func turnRowId(_ h: RoomJobHandedTo) -> String? {
        guard let t = h.turnId else { return nil }
        return t.contains(":") ? t : "\(h.sessionId):\(t)"
    }
}

// MARK: - Local state (optimistic, reconciled by the job's id)

public struct RoomJobLocal: Sendable, Equatable {
    /// An action sent and not yet answered: the line shows it at once.
    public var pending: RoomJobAction?
    /// The target's title when the pending action is Go, so the line can say "Handing to X".
    public var pendingTitle: String?
    /// A refusal or failure, shown inline under the line until the job next changes.
    public var error: String?
    public init(pending: RoomJobAction? = nil, pendingTitle: String? = nil, error: String? = nil) {
        self.pending = pending; self.pendingTitle = pendingTitle; self.error = error
    }
}

// MARK: - The action line

public struct RoomJobButton: Sendable, Equatable, Identifiable {
    public enum Role: Sendable, Equatable { case primary, secondary, quiet }
    public var id: String
    public var title: String
    public var role: Role
    public var action: RoomJobAction
}

/// The one quiet line under a person's message. Pure: the view only draws it.
public struct RoomJobLine: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        case suggestion, newThread, handing, handed, running, done, failed
        /// Dismissed: the line collapses in place (the row stays in the list at zero height, so nothing jumps).
        case collapsed
        /// "Make this a job" was refused or did not go; there is no job yet.
        case makeFailed
    }
    public enum Mark: Sendable, Equatable { case none, working, failed }

    public var id: String
    public var messageId: String
    public var jobId: String?
    public var kind: Kind
    public var mark: Mark
    /// "Looks like a job →", "Handed to", "Done ·": the words before the target.
    public var lead: String
    public var target: RoomJobTarget?
    public var targetTitle: String?
    public var candidates: [RoomJobTarget]
    public var buttons: [RoomJobButton]
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

extension RoomJobs {
    public static let suggestionLead = "Looks like a job \u{2192}"

    public static func line(for job: RoomJob, local: RoomJobLocal? = nil) -> RoomJobLine {
        func base(_ kind: RoomJobLine.Kind, mark: RoomJobLine.Mark = .none, lead: String) -> RoomJobLine {
            RoomJobLine(
                id: "job:" + job.id, messageId: job.messageId, jobId: job.id, kind: kind, mark: mark, lead: lead, target: nil,
                targetTitle: nil, candidates: [], buttons: [], detail: nil, turnRowId: nil, error: local?.error)
        }
        // An action in flight: shown at once, reconciled when the host's job arrives.
        if let p = local?.pending, job.status == .suggested {
            switch p {
            case .dismiss: return base(.collapsed, lead: "")
            case .go:
                var l = base(.handing, mark: .working, lead: "Handing to")
                l.targetTitle = local?.pendingTitle ?? job.suggestion?.title
                return l
            case .newThread: return base(.handing, mark: .working, lead: "Starting a new thread")
            case .allow, .deny: break  // a claim's answer shows on the claim card; the line keeps its words
            }
        }
        switch job.status {
        case .dismissed: return base(.collapsed, lead: "")
        case .suggested:
            if let s = job.suggestion {
                var l = base(.suggestion, lead: suggestionLead)
                l.target = s; l.targetTitle = s.title
                // Other threads the person may pick instead (never the suggestion twice).
                l.candidates = job.candidates.filter { $0.sessionId != s.sessionId }
                l.buttons = [
                    RoomJobButton(id: "go", title: "Go", role: .primary, action: .go(sessionId: s.sessionId)),
                    RoomJobButton(id: "new", title: "New thread", role: .secondary, action: .newThread),
                    RoomJobButton(id: "note", title: "Just a note", role: .quiet, action: .dismiss),
                ]
                return l
            }
            var l = base(.newThread, lead: suggestionLead)
            l.targetTitle = "new thread"
            l.candidates = job.candidates
            l.buttons = [
                RoomJobButton(id: "start", title: "Start", role: .primary, action: .newThread),
                RoomJobButton(id: "note", title: "Just a note", role: .quiet, action: .dismiss),
            ]
            return l
        case .handed:
            var l = base(.handed, lead: "Handed to")
            l.targetTitle = job.handedTo?.title
            if job.handedTo == nil { l.lead = "Handed over" }
            return l
        case .running:
            var l = base(.running, mark: .working, lead: "")
            let t = job.handedTo?.title ?? ""
            l.targetTitle = t.isEmpty ? "A thread" : t
            l.lead = "is on it"
            return l
        case .done:
            var l = base(.done, lead: "Done")
            l.detail = job.outcomeText
            l.turnRowId = job.handedTo.flatMap(turnRowId)
            return l
        case .failed:
            var l = base(.failed, mark: .failed, lead: "Didn\u{2019}t finish")
            l.turnRowId = job.handedTo.flatMap(turnRowId)
            return l
        }
    }

    /// The line for a message that has no job but whose "Make this a job" did not go.
    public static func makeFailedLine(messageId: String, error: String) -> RoomJobLine {
        RoomJobLine(
            id: "jobmsg:" + messageId, messageId: messageId, jobId: nil, kind: .makeFailed, mark: .failed, lead: "Not made a job", target: nil,
            targetTitle: nil, candidates: [], buttons: [], detail: nil, turnRowId: nil, error: error)
    }

    /// The job a message carries (the newest one by creation, then id).
    public static func job(for messageId: String, in jobs: [RoomJob]) -> RoomJob? {
        jobs.last { $0.messageId == messageId }
    }

    /// "Make this a job" is offered on a person's room message that has no live job (a dismissed one may be remade).
    public static func canMakeJob(_ row: RoomRow, jobs: [RoomJob]) -> Bool {
        guard row.post.author.kind == .person, row.post.level == .room, !row.pending, !row.failed, row.post.seq > 0 else { return false }
        guard let j = job(for: row.post.id, in: jobs) else { return true }
        return j.status == .dismissed
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

    public static func claims(jobs: [RoomJob], local: [String: RoomJobLocal] = [:], threads: [RoomThread] = []) -> [ClaimCard] {
        var out: [ClaimCard] = []
        for j in jobs where j.status == .suggested {
            guard let c = j.claim, c.status == .asking else { continue }
            if let p = local[j.id]?.pending, p == .allow || p == .deny { continue }
            let title = c.title.isEmpty ? (threads.first { $0.sessionId == c.sessionId }?.title ?? "A thread") : c.title
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
