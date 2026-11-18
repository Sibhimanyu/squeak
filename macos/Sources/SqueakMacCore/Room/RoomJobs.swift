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
    /// First person, from the host: "worked on the control bar an hour ago" (the duck says "I <pitch>"). Nil from an older host.
    public var pitch: String?
    public init(sessionId: String, title: String, reason: String = "", state: String = "idle", pitch: String? = nil) {
        self.sessionId = sessionId; self.title = title; self.reason = reason; self.state = state; self.pitch = pitch
    }
    private enum CodingKeys: String, CodingKey { case sessionId, title, reason, state, pitch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        state = (try? c.decode(String.self, forKey: .state)) ?? "idle"
        pitch = (try? c.decode(String.self, forKey: .pitch)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
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

/// Where a job's work happens: an existing stream of the pond, or a new one on a branch the host will make.
public enum RoomJobPlace: Sendable, Equatable, Decodable {
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

public struct RoomJob: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var messageId: String
    public var text: String
    public var status: RoomJobStatus
    public var suggestion: RoomJobTarget?
    public var candidates: [RoomJobTarget]
    /// Chosen by the host; absent in a plain-folder pond (no streams) and from an older host.
    public var place: RoomJobPlace?
    public var claim: RoomJobClaim?
    public var handedTo: RoomJobHandedTo?
    public var outcomeText: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(
        id: String, messageId: String, text: String = "", status: RoomJobStatus = .suggested, suggestion: RoomJobTarget? = nil,
        candidates: [RoomJobTarget] = [], claim: RoomJobClaim? = nil, handedTo: RoomJobHandedTo? = nil, outcomeText: String? = nil,
        createdAt: Int64 = 0, updatedAt: Int64 = 0, place: RoomJobPlace? = nil
    ) {
        self.place = place
        self.id = id; self.messageId = messageId; self.text = text; self.status = status; self.suggestion = suggestion
        self.candidates = candidates; self.claim = claim; self.handedTo = handedTo; self.outcomeText = outcomeText
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, messageId, text, status, suggestion, candidates, place, claim, handedTo, outcomeText, createdAt, updatedAt
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
        place = try? c.decode(RoomJobPlace.self, forKey: .place)
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

    public var body: NativeJSON { body(place: nil) }

    /// The request body; `place` rides only on Go, a new duck and Allow (the host refuses it elsewhere).
    public func body(place: RoomJobPlace?) -> NativeJSON {
        var o: [String: NativeJSON]
        switch self {
        case .go(let id):
            o = ["action": .string("go")]
            if let id { o["sessionId"] = .string(id) }
        case .newThread: o = ["action": .string("new")]
        case .dismiss: return .object(["action": .string("dismiss")])
        case .allow: o = ["action": .string("allow")]
        case .deny: return .object(["action": .string("deny")])
        }
        if let place { o["place"] = place.json }
        return .object(o)
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
            case .newThread: return base(.handing, mark: .working, lead: "Starting a new duck")
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
                    RoomJobButton(id: "new", title: "New duck", role: .secondary, action: .newThread),
                    RoomJobButton(id: "note", title: "Just a note", role: .quiet, action: .dismiss),
                ]
                return l
            }
            var l = base(.newThread, lead: suggestionLead)
            l.targetTitle = "new duck"
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
            l.targetTitle = t.isEmpty ? "A duck" : t
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
    public var place: RoomJobPlace
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
    public static func effective(_ job: RoomJob, chosen: RoomJobPlace?) -> RoomJobPlace? { chosen ?? job.place }

    public static func chipText(_ place: RoomJobPlace) -> String {
        switch place {
        case .stream(_, let b): "\u{2192} on \(b)"
        case .new(let b): "\u{2192} new stream \(b)"
        }
    }

    public static func chip(for job: RoomJob, chosen: RoomJobPlace?) -> RoomPlaceChip? {
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
    public static func menu(streams: [RoomStreamChoice], current: RoomJobPlace?, prefill: String) -> [RoomPlaceMenuItem] {
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
    public static func suggestedBranch(job: RoomJob, chosen: RoomJobPlace?) -> String {
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
