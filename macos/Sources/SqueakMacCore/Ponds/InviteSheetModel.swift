import Foundation

// DESIGN.md §8.10, the invite sheet: one sheet, two steps. The view model is pure so the step, the copy button's
// "Copied" moment and the sentences are tested without a window.

public enum InviteStep: Sendable, Equatable { case choose, ready }

/// What a Copy button shows: its label, then "Copied" for `holdFor` seconds, with an injected clock.
public struct CopyFeedback: Sendable, Equatable {
    public static let holdFor: TimeInterval = 1.5
    private var copiedAt: Date?
    public init() {}

    public mutating func copied(at now: Date) { copiedAt = now }
    public func isCopied(now: Date) -> Bool {
        guard let copiedAt else { return false }
        let age = now.timeIntervalSince(copiedAt)
        return age >= 0 && age < Self.holdFor
    }
    public func label(_ plain: String, now: Date) -> String { isCopied(now: now) ? "Copied \u{2713}" : plain }
}

public struct InviteSheetState: Sendable, Equatable {
    public var role: PondRole = .member
    public private(set) var step: InviteStep = .choose
    public private(set) var invite: PondInvite?
    /// The long invite (link, code, QR) made by "Share a link instead"; while there is one the sheet shows it.
    public private(set) var linkInvite: PondInvite?
    public private(set) var makingLink = false
    public private(set) var creating = false
    public private(set) var error: String?
    public var link = CopyFeedback()
    public var code = CopyFeedback()

    public init() {}

    public var canCreate: Bool { step == .choose && !creating }
    /// Esc cancels the first step and finishes the second; either way the sheet closes.
    public var escapeCloses: Bool { true }

    public mutating func startCreating() { creating = true; error = nil }

    /// A short code is on screen (and no long invite replaced it).
    public var showsShort: Bool { invite?.short != nil && linkInvite == nil }
    public mutating func startLink() { makingLink = true; error = nil }
    public mutating func linkCreated(_ invite: PondInvite) { linkInvite = invite; makingLink = false; error = nil }
    public mutating func linkFailed(_ reason: String?) {
        makingLink = false
        error = (reason?.isEmpty == false ? reason : nil) ?? "That didn't go through"
    }
    /// The code's own ten minutes are over: it can no longer be used, and a new one is one press away.
    public func shortExpired(now: Date) -> Bool {
        guard showsShort, let at = invite?.expiresAt else { return false }
        return at <= now
    }
    /// A fresh code replaces a spent or lapsed one.
    public mutating func replaceShort(_ invite: PondInvite) { self.invite = invite; linkInvite = nil; creating = false; error = nil; code = CopyFeedback() }
    public mutating func created(_ invite: PondInvite) { self.invite = invite; creating = false; error = nil; step = .ready }
    /// A refusal stays on the first step, with the host's own sentence and a Retry.
    public mutating func failed(_ reason: String?) {
        creating = false
        error = (reason?.isEmpty == false ? reason : nil) ?? "That didn't go through"
    }

    /// Arrow keys on the cards: left and right move between Member and Viewer and stop at the ends.
    public mutating func move(_ delta: Int) {
        let order: [PondRole] = [.member, .viewer]
        guard let i = order.firstIndex(of: role) else { return }
        role = order[min(max(i + delta, 0), order.count - 1)]
    }

    /// What the person copies and scans: the link when there is one, else the code.
    public var shareText: String { (linkInvite ?? invite)?.shareable ?? "" }
}

public enum InviteSheetText {
    public static func headline(pond: String) -> String { "Invite to \(pond)" }
    public static let subtitle = "People you invite see this pond\u{2019}s threads on their own Mac, iPhone or browser."
    public static let approval = "You approve each person before they join."
    /// The short code's own rule, said where the person chooses and under the code.
    public static let shortNote = "The code works once, for 10 minutes."
    public static let shareLink = "Share a link instead"
    public static let newCode = "Make a new code"
    public static let readyShort = "Tell them this code. They type it in Squeak\u{2019}s Join field or on the guest page."

    /// "Expires in 9:42", or "Code expired" once the ten minutes are over.
    public static func shortExpiry(_ expiresAt: Date?, now: Date) -> String {
        ShortCode.countdown(until: expiresAt, now: now).map { "Expires in \($0)" } ?? "Code expired"
    }
    /// What the owner's approval card and the joiner's waiting card both say beside the three words.
    public static let wordsHint = "Check that these three words match on both screens before you approve."
    public static func wordsHintJoiner(owner: String?) -> String {
        "Ask \(owner ?? "the owner") to check these three words match on their screen."
    }

    public static func roleTitle(_ r: PondRole) -> String { r.word }
    public static func roleBlurb(_ r: PondRole) -> String {
        switch r {
        case .viewer: "Watches threads and reads replies. Can\u{2019}t send."
        default: "Starts threads, sends messages and answers questions."
        }
    }

    /// "Invites expire after 24 hours" from the host's real lifetime (24 h today).
    public static func expiryNote(lifetime: TimeInterval = PondInviteText.lifetime) -> String {
        let hours = Int((lifetime / 3600).rounded())
        if hours >= 48, hours % 24 == 0 { return "Invites expire after \(hours / 24) days." }
        if hours == 24 { return "Invites expire after 1 day." }
        if hours >= 1 { return "Invites expire after \(hours) hour\(hours == 1 ? "" : "s")." }
        return "Invites expire after \(max(1, Int(lifetime / 60))) minutes."
    }

    public static func waiting(role: PondRole) -> String { "Waiting for them \u{2014} you\u{2019}ll be asked to approve." }
}
