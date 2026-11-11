import Foundation

// What a chat says about itself the moment something happens, kept out of the views so it is tested: the line
// under the transcript (sending, working, waiting), the rows computed once, the pace of streamed text, the gaps
// between transcript items and the words an error is shown in.

/// The one line in the dock that says what the chat is doing right now.
public enum ChatIndicator: Equatable, Sendable {
    case sending
    case working
    case waitingApproval
    case background(Int)
    case idle

    public var text: String? {
        switch self {
        case .sending: "Sending…"
        case .working: "Working…"
        case .waitingApproval: "Waiting for you to allow a command"
        case .background(let n): "Waiting for \(n) background \(n == 1 ? "task" : "tasks")"
        case .idle: nil
        }
    }

    /// The dock's line: the state's words (or the activity's, while working) and, after a dot, the model that runs
    /// ("Working… · Opus 5.5 · 1M"). The model is left out when unknown and while the message is still sending.
    public func line(workingLabel: String, model: String?) -> String? {
        guard self != .idle else { return nil }
        let base = text ?? workingLabel
        guard self != .sending, let model = model?.trimmingCharacters(in: .whitespaces), !model.isEmpty else { return base }
        return "\(base) · \(model)"
    }

    /// Whether the dock reserves its running row (the glyph, the clock) for this state.
    public var isActive: Bool { self != .idle }

    /// - `sending`: our last message has not been shown by the host yet (local echo, pending).
    /// - `backgroundWaiting`: the host's `waiting`: the turn ended and only background tasks run. A turn that is
    ///   running with subagents is plain "Working…"; the count only replaces a finished state or that quiet wait.
    public static func resolve(
        state: SessionState, awaitingApproval: Bool, backgroundCount: Int, backgroundWaiting: Bool, sending: Bool
    ) -> ChatIndicator {
        if state == .blocked { return awaitingApproval ? .waitingApproval : .idle }
        if awaitingApproval { return .waitingApproval }
        if sending { return .sending }
        if backgroundCount > 0, state != .error, state != .working || backgroundWaiting { return .background(backgroundCount) }
        if state == .working { return .working }
        return .idle
    }
}

/// `rows` of a chat computed once per change, not once per read: the view asks several times per body and the
/// answer only moves when the messages or the state do. `computeCount` lets a test prove it.
public final class ChatRowsCache {
    public private(set) var computeCount = 0
    private var key: Key?
    private var cached: [ChatTimeline.Row] = []

    private struct Key: Equatable {
        var count: Int
        var first: String?
        var last: String?
        var lastText: Int
        var lastState: MessageState?
        var state: SessionState
        var working: Bool
    }

    public init() {}

    /// The timeline's rows without its working row (the dock draws that one).
    public func rows(messages: [ChatMessage], state: SessionState, now: Date = Date()) -> [ChatTimeline.Row] {
        let working = ChatTimeline.isWorking(messages: messages, state: state, now: now)
        let k = Key(
            count: messages.count, first: messages.first?.id, last: messages.last?.id, lastText: messages.last?.text.utf8.count ?? 0,
            lastState: messages.last?.state, state: state, working: working)
        if k == key { return cached }
        computeCount += 1
        key = k
        cached = ChatTimeline.rows(messages: messages, state: state, activity: [], now: now).filter {
            if case .working = $0 { false } else { true }
        }
        return cached
    }
}

/// Lets streamed text reach the screen at most about 15 times a second. The text itself is never dropped: the
/// caller keeps the newest and publishes it on the next admitted push or its trailing flush.
public struct PublishGate: Sendable {
    public let interval: TimeInterval
    private var last: Date?

    public init(interval: TimeInterval = 1.0 / 15.0) { self.interval = interval }

    /// True when it is time to publish; records the time. `force` always admits (a block ended, the turn ended).
    public mutating func admit(now: Date, force: Bool = false) -> Bool {
        if force || last == nil || now.timeIntervalSince(last!) >= interval {
            last = now
            return true
        }
        return false
    }

    /// How long until the next push would be admitted: the trailing flush's delay.
    public func wait(now: Date) -> TimeInterval {
        guard let last else { return 0 }
        return max(0, interval - now.timeIntervalSince(last))
    }
}

/// The gaps between transcript items (DESIGN.md spacing tokens: xs 4, s 8, m 12): consecutive tool rows sit close,
/// a change of kind breathes, and messages keep the widest.
public enum ChatSpacing {
    public enum Kind: Equatable, Sendable { case message, thinking, tool }

    public static let toolToTool: CGFloat = 4
    public static let kindChange: CGFloat = 8
    public static let turnToMessage: CGFloat = 12
    public static let messageToMessage: CGFloat = 12

    public static func gap(from prev: Kind?, to next: Kind) -> CGFloat {
        guard let prev else { return 0 }
        switch (prev, next) {
        case (.tool, .tool): return toolToTool
        case (.message, .message): return messageToMessage
        case (.message, _), (_, .message): return turnToMessage
        default: return kindChange
        }
    }
}

/// A turn's items with the gap above each, so the view draws them in one stack with no per-row guessing.
public enum TurnLayout {
    public struct Entry: Equatable, Identifiable, Sendable {
        public var item: TurnItem
        public var gap: CGFloat
        public var id: String { item.id }
    }

    public static func kind(_ item: TurnItem) -> ChatSpacing.Kind {
        switch item {
        case .thinking: .thinking
        case .tool: .tool
        }
    }

    public static func entries(_ items: [TurnItem]) -> [Entry] {
        var out: [Entry] = []
        var prev: ChatSpacing.Kind?
        for item in items {
            let k = kind(item)
            out.append(Entry(item: item, gap: ChatSpacing.gap(from: prev, to: k)))
            prev = k
        }
        return out
    }

    /// Thinking folds to one line: "Thought for 3s", or "Thinking…" while it is live.
    public static func thinkingTitle(seconds: Int?, live: Bool) -> String {
        live ? "Thinking…" : ElapsedFormat.thought(seconds)
    }
}

/// The words an error is shown in: the host's own fixed sentence when it gave one, else a plain one. Never
/// "internal error", a status code, a body or a token.
public enum ChatErrorText {
    public static let generic = "Something went wrong on Squeak's side. Try again."

    public static func hostSentence(status: Int, message: String?) -> String {
        let m = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lower = m.lowercased()
        if m.isEmpty || lower.contains("internal") || lower.contains("exception") || lower.contains("stack")
            || lower.hasPrefix("{") || m.count > 160 {
            return status >= 500 || m.isEmpty ? generic : "Squeak's session host refused that"
        }
        return m
    }
}
