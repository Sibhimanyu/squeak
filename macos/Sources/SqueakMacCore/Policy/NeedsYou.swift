import Foundation

/// The one rule for "needs you" (the Mac's copy of the host's `src/fleet/needs-you.ts`, same cases, same tests): a chat
/// needs the person when it waits on an approval, an answer or a plan, repeats a failing step, or failed and the person has
/// not yet seen it. The sidebar's pond mark, the Pond Dashboard's tile, the board, the Duck badges and the lists all read
/// this, so they cannot count differently.
///
/// A failure stops counting when the person opens the chat or dismisses it (the host's `errorSeenAt`), when the chat is sent
/// anything (it leaves the error state), and after `failedStaysFor` (24 h) untouched, so an old failure never holds a red
/// mark on a Pond for ever. The failure's own row stays in the transcript either way.
public enum NeedsYouReason: Equatable, Sendable {
    case approval, answer, plan, looping, failed

    /// The words a list, a tooltip and VoiceOver use.
    public var words: String {
        switch self {
        case .approval: WaitingKind.approval.words
        case .answer: WaitingKind.answer.words
        case .plan: WaitingKind.plan.words
        case .looping: WaitingKind.looping.words
        case .failed: "Failed"
        }
    }
}

public enum NeedsYou {
    /// How long an unseen failure keeps counting (the same window finished and failed chats stay recent in the lists).
    public static let failedStaysFor: TimeInterval = SessionGrouping.recentWindow

    public static func reason(of s: HostSession, now: Date = Date()) -> NeedsYouReason? {
        if s.isLoopingNow { return .looping }
        switch s.state {
        case .blocked where s.alive != false:
            if s.awaitingApproval == true { return .approval }
            return s.pendingQuestion == PendingQuestion.planDetail ? .plan : .answer
        case .error where failureCounts(s, now: now): return .failed
        default: return nil
        }
    }

    /// A failure the person has not seen, still young enough to count.
    public static func failureCounts(_ s: HostSession, now: Date = Date()) -> Bool {
        guard s.state == .error, s.errorSeenAt == nil, s.archivedAt == nil else { return false }
        // No date to judge by: count it, never hide a failure for want of one.
        guard let at = s.lastActivityAt else { return true }
        return now.timeIntervalSince(at) <= failedStaysFor
    }
}

/// One chat that needs the person, as a list draws it.
public struct NeedsYouItem: Equatable, Sendable, Identifiable {
    public var key: SessionKey
    public var title: String
    public var reason: NeedsYouReason
    /// The failure's own words (only for `failed`).
    public var text: String?
    public var at: Date?
    public var id: SessionKey { key }

    /// "Failed: <why>", or the waiting sentence.
    public var sentence: String { reason == .failed ? (text.map { "Failed: \($0)" } ?? "Failed") : reason.words }
}

/// What a pond's one mark says and where a click goes (DESIGN.md §3.3, "Stream and pond marks"): the chats the one rule
/// names, newest first. One chat opens that chat; several open the Pond's Needs-you list.
public enum PondNeedsYou {
    public enum Target: Equatable, Sendable {
        case nothing
        case chat(SessionKey)
        case list
    }

    public static func items(_ chats: [HostSession], title: (HostSession) -> String, now: Date = Date()) -> [NeedsYouItem] {
        chats.compactMap { s -> NeedsYouItem? in
            guard let reason = NeedsYou.reason(of: s, now: now) else { return nil }
            return NeedsYouItem(key: s.key, title: title(s), reason: reason, text: reason == .failed ? s.failureText : nil, at: s.lastActivityAt)
        }
        .sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
    }

    public static func target(_ items: [NeedsYouItem]) -> Target {
        items.count == 1 ? .chat(items[0].key) : (items.isEmpty ? .nothing : .list)
    }

    /// The hover text: "1 chat failed: Zoom SDK Video Subscription Instability", "2 chats failed: A, B", "3 chats need you: A, B and 1 more".
    public static func help(_ items: [NeedsYouItem], shown: Int = 3) -> String {
        guard !items.isEmpty else { return "" }
        let n = items.count
        let noun = n == 1 ? "1 chat" : "\(n) chats"
        let verb = items.allSatisfy { $0.reason == .failed } ? "failed" : (n == 1 ? "needs you" : "need you")
        let names = items.prefix(shown).map(\.title).joined(separator: ", ")
        let rest = n > shown ? " and \(n - shown) more" : ""
        return "\(noun) \(verb): \(names)\(rest)"
    }
}
