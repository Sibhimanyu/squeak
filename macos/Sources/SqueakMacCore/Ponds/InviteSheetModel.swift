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
    public private(set) var creating = false
    public private(set) var error: String?
    public var link = CopyFeedback()
    public var code = CopyFeedback()

    public init() {}

    public var canCreate: Bool { step == .choose && !creating }
    /// Esc cancels the first step and finishes the second; either way the sheet closes.
    public var escapeCloses: Bool { true }

    public mutating func startCreating() { creating = true; error = nil }
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
    public var shareText: String { invite?.shareable ?? "" }
}

public enum InviteSheetText {
    public static func headline(pond: String) -> String { "Invite to \(pond)" }
    public static let subtitle = "People you invite see this pond\u{2019}s threads on their own Mac, iPhone or browser."
    public static let approval = "You approve each person before they join."

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
