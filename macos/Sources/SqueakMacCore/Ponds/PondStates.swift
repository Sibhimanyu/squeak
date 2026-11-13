import Foundation

// The owner's rule: every person always sees a clear state. The host makes each state's sentence (`statusLine`,
// `offlineLine`, a thread's `stateLine`); this file only decides which card, which buttons and which fallback words
// when an older host sent none, so CI can pin them and every surface (sidebar, home, panel, menu bar) says the same.

// MARK: A pond's own state

/// What a pond row, home header, panel or menu-bar entry says about the pond's state, and what it offers.
public struct PondStateCard: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case calm, waiting, problem }

    public var title: String
    public var line: String
    public var tone: Tone
    /// "Remove" (the terminal states: the row stays until pressed) or "Cancel request" (pending); nil when there is nothing to press.
    public var button: String?
    /// Pressing the button calls forget (terminal) rather than cancel (pending).
    public var forgets: Bool
}

public enum PondStates {
    public static let onlyThisMac = "Only on this Mac"

    /// The card for a pond that is not an ordinary active one; nil for `active`.
    public static func card(for pond: PondSummary) -> PondStateCard? {
        let owner = pond.ownerName.flatMap { $0.isEmpty ? nil : $0 }
        let who = owner ?? "the owner"
        let role = (pond.requestedRole ?? .member).word.lowercased()
        switch pond.state {
        case .active: return nil
        case .local:
            return PondStateCard(title: onlyThisMac, line: pond.statusLine ?? "Only on this Mac. Invite someone to share it.", tone: .calm, button: nil, forgets: false)
        case .pending:
            return PondStateCard(
                title: "Waiting for approval", line: pond.statusLine ?? "Waiting for \(who) to approve you as a \(role).", tone: .waiting,
                button: "Cancel request", forgets: false)
        case .declined:
            return PondStateCard(title: "Your request was declined", line: pond.statusLine ?? "\(owner ?? "The owner") declined your request.", tone: .problem, button: "Remove", forgets: true)
        case .expired:
            return PondStateCard(
                title: "This invite expired", line: pond.statusLine ?? "This invite expired before \(who) answered. Ask for a new one.", tone: .problem, button: "Remove", forgets: true)
        case .revoked:
            return PondStateCard(title: "This invite was withdrawn", line: pond.statusLine ?? "\(owner ?? "The owner") withdrew this invite.", tone: .problem, button: "Remove", forgets: true)
        case .removed:
            return PondStateCard(title: "You were removed", line: pond.statusLine ?? "You were removed from \(pond.name).", tone: .problem, button: "Remove", forgets: true)
        }
    }

    /// The sidebar's greyed row: "<pond> · Waiting for approval".
    public static func rowTitle(_ pond: PondSummary) -> String {
        guard let card = card(for: pond), pond.state != .local, pond.state != .active else { return pond.name }
        return "\(pond.name) \u{00B7} \(card.title)"
    }

    /// A pond that gets a greyed row of its own: waiting or ended. (An active or local pond is an ordinary row.)
    public static func isGreyedRow(_ pond: PondSummary) -> Bool { pond.state == .pending || pond.state.isTerminal }

    /// The one line under a pond's header: what is true of it right now.
    public static func headerLine(_ pond: PondSummary?) -> String? {
        guard let pond else { return onlyThisMac + ". Invite someone to share it." }
        if pond.state == .local { return pond.statusLine ?? "Only on this Mac. Invite someone to share it." }
        return pond.statusLine.flatMap { pond.state == .active ? nil : $0 }
    }

    /// The flock's gloss, said once where the word first appears.
    public static let flockGloss = "Flock \u{2014} the people in this pond."
}

// MARK: Offline and loading

public enum PondFreshness: Sendable, Equatable {
    /// Fresh data, nothing to say.
    case live
    /// The first read of this pond is on its way: never an empty flock drawn as if real.
    case reading
    /// The first read failed and there is nothing to show.
    case couldntRead
    /// Showing the last read while a newer one is on its way.
    case refreshing
    /// The host served its last good read because the relay could not be reached.
    case offline(line: String, asOf: Date?)
    /// The app could not reach the host this time; the last read stays on screen.
    case stale

    /// The words for the strip above the pond; nil when there is nothing to say.
    public var line: String? {
        switch self {
        case .live: nil
        case .reading: "Reading the pond\u{2026}"
        case .couldntRead: "Couldn\u{2019}t read the pond. Try again in a moment."
        // Data is already on screen: a background read says nothing (a strip would insert a row and shift the page).
        case .refreshing: nil
        case .offline(let line, _): line
        case .stale: "Can\u{2019}t reach the pond right now. Showing what Squeak read last."
        }
    }

    public var isProblem: Bool {
        switch self {
        case .couldntRead, .offline, .stale: true
        default: false
        }
    }

    /// Writes (invite, approve, remove, rename, rotate) wait while the pond is offline, with the reason.
    public var writesDisabledReason: String? {
        switch self {
        case .offline, .stale: "Squeak can\u{2019}t reach the pond right now. This works again when it\u{2019}s back."
        default: nil
        }
    }

    public var canWrite: Bool { writesDisabledReason == nil }

    /// `detail`: what is held for the pond (nil before the first read). `reading`: a read is in flight. `failed`: the last read failed.
    public static func of(detail: PondDetail?, pond: PondSummary?, reading: Bool, failed: Bool, now: Date = Date()) -> PondFreshness {
        let offline = detail?.pond.offline == true || pond?.offline == true
        if offline {
            let line = detail?.pond.offlineLine ?? pond?.offlineLine
            let asOf = detail?.pond.asOf ?? pond?.asOf
            return .offline(line: line ?? offlineSentence(asOf: asOf), asOf: asOf)
        }
        if detail == nil { return failed ? .couldntRead : (reading ? .reading : .live) }
        if failed { return .stale }
        return reading ? .refreshing : .live
    }

    /// The fallback for an older host that says `offline` with no sentence of its own.
    public static func offlineSentence(asOf: Date?) -> String {
        guard let asOf else { return "Can\u{2019}t reach Squeak\u{2019}s cloud. Showing what was here before." }
        return "Can\u{2019}t reach Squeak\u{2019}s cloud. Showing what was here at \(asOf.formatted(date: .omitted, time: .shortened))."
    }
}

// MARK: Needs-you count

public enum PondBadge {
    /// The sidebar badge and menu-bar count: the host's threads waiting plus, for an owner, the join requests nobody has answered.
    public static func count(pond: PondSummary, detail: PondDetail?) -> Int {
        guard pond.state == .active || pond.state == .local else { return 0 }
        let joins = (detail?.myRole ?? pond.role).canApproveJoins ? (detail?.joins.count ?? 0) : 0
        return pond.needsYou + joins
    }

    /// Ponds this person owns that are shared: their requests are read even when the pond is not open.
    public static func readsJoins(_ pond: PondSummary) -> Bool { pond.role.canApproveJoins && pond.state == .active && !pond.local }
}

// MARK: Join cards (owner)

public enum JoinCardText {
    /// "From Priya's MacBook" / "From a web browser".
    public static func source(_ j: JoinRequest) -> String {
        if j.isWeb { return "From a web browser" }
        if let nest = j.nest, !nest.isEmpty { return "From \(nest)" }
        return "From Squeak on a Mac"
    }

    /// "priya@gmail.com \u{00B7} Verified" (a sign-in provider vouched for the address), else nil.
    public static func email(_ j: JoinRequest) -> String? { j.verifiedEmail.map { "\($0) \u{00B7} Verified" } }

    public static func title(_ j: JoinRequest, pond: String?) -> String {
        "\(j.displayName) wants to join" + (pond.map { " \($0)" } ?? "")
    }

    /// What the card says about its decision: the local press first ("Approving…" the instant it is pressed), then the host's
    /// word, and a failure as one sentence that says what to do.
    public static func decisionLine(_ j: JoinRequest, pressing: Bool?) -> (text: String, failed: Bool)? {
        if let pressing { return (pressing ? "Approving\u{2026}" : "Declining\u{2026}", false) }
        guard let host = j.decisionLine else { return nil }
        if j.decisionFailed {
            let verb = j.decisionApprove == false ? "decline" : "approve"
            let again = j.decisionApprove == false ? "Decline" : "Approve"
            return ("Couldn\u{2019}t \(verb) \(j.displayName): \(host.hasSuffix(".") ? String(host.dropLast()) : host). \(again) to try again.", true)
        }
        return (host, false)
    }

    public static let hint = "Approve only people you know."
}

// MARK: Invites list (owner)

public struct PondInviteRow: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var line: String
    public var pending: Bool
    public var canCopy: Bool
    public var canRevoke: Bool
    public var tone: PondStateCard.Tone
    /// Pending, or used/ended less than a day ago; the rest fold under "Earlier invites".
    public var recent: Bool
}

public enum PondInvites {
    public static func rows(_ invites: [PondInviteEntry], now: Date) -> [PondInviteRow] {
        invites.sorted {
            let a = $0.createdAt ?? .distantPast, b = $1.createdAt ?? .distantPast
            return a != b ? a > b : $0.id < $1.id
        }.map { row($0, now: now) }
    }

    public static func row(_ i: PondInviteEntry, now: Date) -> PondInviteRow {
        // A pending invite past its expiry is expired, whatever the host last wrote.
        let lapsed = i.state == .pending && (i.expiresAt.map { $0 <= now } ?? false)
        let state: PondInviteEntry.State = lapsed ? .expired : i.state
        let by = i.usedBy.map { $0.isEmpty ? "Someone" : $0 } ?? "Someone"
        let title = "\(i.role.word) invite"
        let line: String
        var tone = PondStateCard.Tone.calm
        switch state {
        case .pending: line = "Waiting for someone to use it" + (PondInviteText.expiry(i.expiresAt, now: now).map { " \u{00B7} \($0)" } ?? "")
        case .accepted: line = "\(by) joined"
        case .declined: line = "\(by) was declined"; tone = .problem
        case .expired: line = "Expired"; tone = .problem
        case .revoked: line = "Revoked"; tone = .problem
        }
        let reference = i.createdAt ?? i.expiresAt ?? now
        let pending = state == .pending
        return PondInviteRow(
            id: i.id, title: title, line: line, pending: pending, canCopy: pending && i.shareable != nil, canRevoke: pending, tone: tone,
            recent: pending || now.timeIntervalSince(reference) < 24 * 3600)
    }

    public static let earlierTitle = "Earlier invites"
    public static let revokeWarning = "The link and code stop working."
    public static let oneEach = "Each invite is for one person."
}

// MARK: Members (owner's list)

public enum PondMembers {
    /// "Online", "Last seen 4 min ago", or nothing: never "Away" for a person the app has no reading of.
    public static func seen(_ m: FlockMember, presence: [PondPresenceEntry], threads: [PondThread], pondOffline: Bool, now: Date) -> String? {
        if pondOffline { return m.lastSeenAt.map { "Last seen \(PondMembers.ago($0, now: now))" } }
        if let p = presence.first(where: { $0.member == m.id }), p.online {
            if p.typingIn != nil { return "Typing" }
            if let id = p.viewing, let t = threads.first(where: { $0.id == id }), !t.title.isEmpty { return "Viewing \(t.title)" }
            return "Online"
        }
        if m.online { return "Online" }
        return m.lastSeenAt.map { "Last seen \(PondMembers.ago($0, now: now))" }
    }

    public static func ago(_ date: Date, now: Date) -> String {
        let s = now.timeIntervalSince(date)
        return s < 60 ? "just now" : "\(PondSentence.span(s)) ago"
    }

    /// The role chip's words (always shown, so a plain member and an unknown role never look alike).
    public static func chip(_ m: FlockMember) -> String { m.role.word }

    /// The roles an owner may change someone to (not the owner's own).
    public static func rolesToChangeTo(_ m: FlockMember) -> [PondRole] {
        m.role == .owner || m.you ? [] : [PondRole.member, .viewer].filter { $0 != m.role }
    }

    /// Which machine a member is on: "Aarav\u{2019}s MacBook", "Web", or nil.
    public static func machine(_ m: FlockMember) -> String? {
        if m.you { return "This Mac" }
        if let n = m.machine { return n }
        return m.client == "web" || m.nest == nil ? "Web" : nil
    }
}

// MARK: Owner actions' words

public enum PondActionWords {
    public static let rotateExplain = "Everyone in the pond keeps access. Anyone removed before this can\u{2019}t read new messages. Use it if a key or device may have leaked."
    public static func leaveMessage(_ pond: String) -> String { "You will lose access to \(pond) and its threads. The owner can invite you again." }
    public static func deleteMessage(_ pond: String, others: Int) -> String {
        let who = others <= 0 ? "No one else" : (others == 1 ? "1 other person" : "\(others) other people")
        return "\(who) will lose access to \(pond) and everything shared in it. Your folder and files on this Mac stay. This can\u{2019}t be undone."
    }
    public static func removeFromSqueakWarning(_ pond: String, others: Int) -> String {
        let n = others <= 0 ? "other people" : (others == 1 ? "1 other person" : "\(others) other people")
        return "\(pond) is shared with \(n). Delete the pond first (they lose access) or leave it, then remove it from Squeak. Its folder and files stay on this Mac."
    }
    public static let removeLocal = "Its folder and files stay on this Mac. You can add it back later."
}

// MARK: Ripples

public enum PondRipples2 {
    /// "<actorName or You> <text>": the host's text never repeats the actor, so the name is put in front; an older host's
    /// text that already starts with the name is shown as it is.
    public static func sentence(_ e: RippleEntry, me: String?) -> String {
        let isMe = me != nil && !e.actor.isEmpty && e.actor == me
        let name = isMe ? "You" : e.actorName
        if name.isEmpty || e.text.hasPrefix(name) || (isMe && e.text.hasPrefix(e.actorName) && !e.actorName.isEmpty) { return e.text }
        return "\(name) \(e.text)"
    }
}

// MARK: Pending messages (a member's own sends)

/// A message this Mac's person sent into someone else's thread, until the starter's Mac has taken it.
public struct PondOutgoing: Sendable, Equatable, Identifiable {
    public enum State: Sendable, Equatable { case sending, queued, sent, refused(String) }

    public var id: UUID
    public var text: String
    public var sentAt: Date
    public var state: State

    public init(id: UUID = UUID(), text: String, sentAt: Date, state: State = .sending) { self.id = id; self.text = text; self.sentAt = sentAt; self.state = state }

    /// The line under the message.
    public func line(starter: String, now: Date) -> String {
        switch state {
        case .sending: return "Sending\u{2026}"
        case .sent: return "Sent."
        case .refused(let why): return why
        case .queued:
            let name = starter.isEmpty ? "the starter\u{2019}s Mac" : "\(starter)\u{2019}s Mac"
            return now.timeIntervalSince(sentAt) > 90 ? "\(name) hasn\u{2019}t picked this up yet. It may be asleep." : "Waiting for \(name) to pick it up."
        }
    }

    public var isRefused: Bool { if case .refused = state { true } else { false } }
}

public enum PondOutbox {
    /// The result of the host's answer as a state; a refusal carries its reason (a fixed sentence if the host sent none).
    public static func state(for r: PondSendResult) -> PondOutgoing.State {
        switch r.state {
        case .queued: .queued
        case .sent: .sent
        case .refused: .refused(r.line ?? "That message wasn\u{2019}t sent.")
        }
    }

    /// Drops what the transcript now shows: a `user` event from this person with the same words means it was delivered.
    /// A `sent` message is kept only until the event arrives. Refused ones stay until the person dismisses them.
    public static func settle(_ list: [PondOutgoing], events: [ThreadEvent], me: String?) -> [PondOutgoing] {
        let mine = events.compactMap { e -> String? in
            if case .user(let by, let text) = e.kind, by == nil || by == me { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            return nil
        }
        var left = mine
        return list.filter { o in
            if o.isRefused { return true }
            if let i = left.firstIndex(of: o.text.trimmingCharacters(in: .whitespacesAndNewlines)) { left.remove(at: i); return false }
            return true
        }
    }
}

// MARK: A thread's state for a member

public enum PondThreadStatus {
    public static let viewerLine = "You\u{2019}re a viewer: you can read but not send."

    /// The line under the header: the host's, else a fallback from what an older host does send.
    public static func line(_ t: PondThread) -> String? {
        if let l = t.stateLine { return l }
        if t.starterOnline == false { return "\(machine(t))\u{2019}s Mac is offline" }
        return nil
    }

    private static func machine(_ t: PondThread) -> String {
        if !t.starterName.isEmpty { return t.starterName }
        return t.nestName ?? t.nest ?? "The starter"
    }

    public static var isOffline: (PondThread) -> Bool { { $0.starterOnline == false } }

    /// Approve and Stop stay with the starter, said where a member would look for them.
    public static func ownershipLine(starterName: String, isStarter: Bool) -> String? {
        isStarter ? nil : "Approve and Stop stay with \(starterName.isEmpty ? "the person who started it" : starterName)."
    }

    /// Why the composer is closed: a viewer, or a chat that runs without asking (only its starter may message it).
    public static func composerBlock(role: PondRole, asks: Bool?, isStarter: Bool, starterName: String) -> String? {
        if !role.canMessage { return viewerLine }
        if asks == false, !isStarter { return "Only \(starterName.isEmpty ? "the starter" : starterName) can message this thread while it runs without asking." }
        return nil
    }

    /// Whether answer controls (question buttons, the answer box) are offered: a viewer reads only.
    public static func canAnswer(role: PondRole) -> Bool { role.canMessage }

    /// "Private" or "Shared with the pond", for a row or a switch's caption.
    public static func visibility(isPrivate: Bool) -> String { isPrivate ? "Private" : "Shared with the pond" }
}

// MARK: Notifications from list and view transitions

public struct PondNote: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable { case joinRequest, joined, approved, declined, expired, revoked, removed, threadNeedsYou }
    public var id: String
    public var kind: Kind
    public var title: String
    public var body: String
    public var pondId: String
}

public enum PondNotes {
    /// What the joiner is told when their pond's status changes: one notification per transition.
    public static func joiner(old: [PondSummary], new: [PondSummary]) -> [PondNote] {
        let before = Dictionary(old.map { ($0.id, $0.state) }, uniquingKeysWith: { a, _ in a })
        return new.compactMap { p -> PondNote? in
            guard let was = before[p.id], was != p.state else { return nil }
            let owner = p.ownerName.flatMap { $0.isEmpty ? nil : $0 }
            func note(_ kind: PondNote.Kind, _ title: String, _ body: String) -> PondNote {
                PondNote(id: "pond-\(kind)-\(p.id)", kind: kind, title: title, body: body, pondId: p.id)
            }
            switch (was, p.state) {
            case (.pending, .active), (.pending, .local): return note(.approved, "You\u{2019}re in \(p.name)", "\(owner ?? "The owner") approved your request.")
            case (_, .declined) where was == .pending: return note(.declined, "\(owner ?? "The owner") declined your request", p.name)
            case (_, .expired) where was == .pending: return note(.expired, "This invite expired", "\(p.name): \(p.statusLine ?? "Ask for a new one.")")
            case (_, .revoked) where was == .pending: return note(.revoked, "This invite was withdrawn", "\(p.name): \(p.statusLine ?? "Ask for a new one.")")
            case (.active, .removed), (.pending, .removed): return note(.removed, "You were removed from \(p.name)", p.statusLine ?? "The owner took you out of the pond.")
            default: return nil
            }
        }
    }

    /// The owner's: each join request not seen before, and each new member. `oldJoins` nil means the pond was not read yet,
    /// so nothing is announced from a first read except requests still waiting (each is announced once by `seen`).
    public static func owner(pond: PondSummary, old: PondDetail?, new: PondDetail, seen: Set<String>) -> [PondNote] {
        guard new.myRole.canApproveJoins else { return [] }
        var out: [PondNote] = []
        for j in new.joins where !seen.contains(j.id) && j.decisionState != "working" {
            out.append(PondNote(id: "pond-join-\(j.id)", kind: .joinRequest, title: "\(j.displayName) wants to join \(pond.name)", body: JoinCardText.source(j) + ". " + JoinCardText.hint, pondId: pond.id))
        }
        if let old {
            let known = Set(old.members.map(\.id))
            for m in new.members where !m.you && !known.contains(m.id) {
                out.append(PondNote(id: "pond-member-\(m.id)", kind: .joined, title: "\(m.name.isEmpty ? "Someone" : m.name) joined \(pond.name)", body: "They\u{2019}re in the flock now.", pondId: pond.id))
            }
        }
        return out
    }

    /// A member's: a teammate's thread that just started waiting on a question a member may answer. Approvals stay with the starter.
    public static func threads(pond: PondSummary, old: PondDetail?, new: PondDetail) -> [PondNote] {
        guard let old, new.myRole.canMessage else { return [] }
        let me = new.meMember?.id ?? new.me?.id
        let was = Dictionary(old.threads.map { ($0.id, PondThreadState(raw: $0.state)) }, uniquingKeysWith: { a, _ in a })
        return new.threads.compactMap { t -> PondNote? in
            guard t.starter != me, PondThreadState(raw: t.state) == .needsYou, let before = was[t.id], before != .needsYou else { return nil }
            // The host says what it waits on in `stateLine`; an approval ("Waiting for Sibhi to approve an edit") is the starter's alone.
            if let line = t.stateLine?.lowercased(), line.contains("approve") { return nil }
            let from = t.starterName.isEmpty ? "A teammate" : t.starterName
            return PondNote(id: "pond-thread-\(t.id)-\(t.updatedAt.map { Int($0.timeIntervalSince1970) } ?? 0)", kind: .threadNeedsYou, title: "\(t.title.isEmpty ? "A thread" : t.title) needs you", body: "\(from)\u{2019}s thread in \(pond.name) has a question.", pondId: pond.id)
        }
    }
}

// MARK: Sidebar

public enum PondSidebar {
    /// Active ponds with no project on this Mac (joined by invite): they get a row even with no sessions yet.
    public static func joinedNames(_ ponds: [PondSummary], existing: [String]) -> [String] {
        let have = Set(existing.map { $0.lowercased() })
        var seen = Set<String>()
        return ponds.filter { $0.state == .active && $0.projectId == nil && !$0.local }
            .map(\.name).filter { !have.contains($0.lowercased()) && seen.insert($0.lowercased()).inserted }
    }

    /// "Only on this Mac" for a local pond, the host's sentence for a waiting or ended one; nothing for a shared one.
    public static func tooltip(_ pond: PondSummary) -> String? {
        if pond.state == .local { return PondStates.onlyThisMac }
        return PondStates.card(for: pond)?.line
    }
}
