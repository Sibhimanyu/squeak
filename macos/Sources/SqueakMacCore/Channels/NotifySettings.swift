import Foundation

/// What each channel may push: `GET /control/notify` and `POST /control/notify`. The daemon owns the
/// rules (`src/fleet/notify-settings.ts`); this only shapes, validates and rolls back edits.

public enum NotifyChannel: String, Sendable, CaseIterable {
    case telegram, cliq
    public var title: String { self == .telegram ? "Telegram" : "Zoho Cliq" }
}

public enum NotifyFinished: String, Sendable, CaseIterable, Equatable {
    case conductor, all, off
    public var title: String {
        switch self {
        case .conductor: "Conductor chats"
        case .all: "All agents"
        case .off: "Off"
        }
    }
}

/// Local clock times, "HH:MM" 24 h; `from` to `to` may cross midnight, and the two must differ.
public struct NotifyQuiet: Sendable, Equatable {
    public var from: String
    public var to: String
    public init(from: String, to: String) { self.from = from; self.to = to }

    public static let standard = NotifyQuiet(from: "22:00", to: "07:00")

    public static func minutes(_ clock: String) -> Int? {
        let p = clock.split(separator: ":", omittingEmptySubsequences: false)
        guard p.count == 2, p[0].count == 2, p[1].count == 2, let h = Int(p[0]), let m = Int(p[1]),
              (0..<24).contains(h), (0..<60).contains(m) else { return nil }
        return h * 60 + m
    }

    public static func clock(hour: Int, minute: Int) -> String {
        String(format: "%02d:%02d", hour, minute)
    }

    public var isValid: Bool {
        guard let a = Self.minutes(from), let b = Self.minutes(to) else { return false }
        return a != b
    }

    /// "22:00 to 07:00", or "10:00 PM to 7:00 AM" when `twentyFourHour` is false.
    public func summary(twentyFourHour: Bool = true) -> String {
        "\(Self.display(from, twentyFourHour)) to \(Self.display(to, twentyFourHour))"
    }

    public static func display(_ clock: String, _ twentyFourHour: Bool) -> String {
        guard let m = minutes(clock) else { return clock }
        if twentyFourHour { return clock }
        let h = m / 60, mm = m % 60
        return String(format: "%d:%02d %@", h % 12 == 0 ? 12 : h % 12, mm, h < 12 ? "AM" : "PM")
    }
}

public struct ChannelNotify: Sendable, Equatable, Decodable {
    public var muted = false
    public var approval = true
    public var question = true
    public var stalled = true
    public var quota = true
    public var finished: NotifyFinished = .conductor
    public var quiet: NotifyQuiet?

    public init() {}

    enum CodingKeys: String, CodingKey { case muted, approval, question, stalled, quota, finished, quiet }
    struct Quiet: Decodable { var from: String?; var to: String? }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        muted = c.lenient(Bool.self, .muted) ?? false
        approval = c.lenient(Bool.self, .approval) ?? true
        question = c.lenient(Bool.self, .question) ?? true
        stalled = c.lenient(Bool.self, .stalled) ?? true
        quota = c.lenient(Bool.self, .quota) ?? true
        finished = c.lenient(String.self, .finished).flatMap(NotifyFinished.init(rawValue:)) ?? .conductor
        if let q = c.lenient(Quiet.self, .quiet), let f = q.from, let t = q.to {
            let window = NotifyQuiet(from: f, to: t)
            if window.isValid { quiet = window }
        }
    }

    public func applying(_ change: NotifyChange) -> ChannelNotify {
        var s = self
        switch change {
        case .muted(let v): s.muted = v
        case .approval(let v): s.approval = v
        case .question(let v): s.question = v
        case .stalled(let v): s.stalled = v
        case .quota(let v): s.quota = v
        case .finished(let v): s.finished = v
        case .quiet(let v): s.quiet = v
        }
        return s
    }

    /// The change that puts back what `change` replaces in this state: the rollback of an optimistic edit.
    public func reverting(_ change: NotifyChange) -> NotifyChange {
        switch change {
        case .muted: .muted(muted)
        case .approval: .approval(approval)
        case .question: .question(question)
        case .stalled: .stalled(stalled)
        case .quota: .quota(quota)
        case .finished: .finished(finished)
        case .quiet: .quiet(quiet)
        }
    }
}

/// One change, exactly one key per request, as the daemon requires.
public enum NotifyChange: Sendable, Equatable {
    case muted(Bool), approval(Bool), question(Bool), stalled(Bool), quota(Bool)
    case finished(NotifyFinished)
    case quiet(NotifyQuiet?)

    public var key: String {
        switch self {
        case .muted: "muted"
        case .approval: "approval"
        case .question: "question"
        case .stalled: "stalled"
        case .quota: "quota"
        case .finished: "finished"
        case .quiet: "quiet"
        }
    }

    /// False when the change would be refused: a quiet window with a bad or equal pair of times.
    public var isValid: Bool {
        if case .quiet(let q?) = self { return q.isValid }
        return true
    }

    var jsonValue: Any {
        switch self {
        case .muted(let v), .approval(let v), .question(let v), .stalled(let v), .quota(let v): v
        case .finished(let v): v.rawValue
        case .quiet(let q): q.map { ["from": $0.from, "to": $0.to] as [String: String] } ?? NSNull()
        }
    }

    /// The POST body: `{ channel, change: { <key>: value } }`.
    public func requestBody(channel: NotifyChannel) -> Data {
        let object: [String: Any] = ["channel": channel.rawValue, "change": [key: jsonValue]]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

/// `GET /control/notify`. A channel the daemon does not describe is nil.
public struct NotifySettings: Sendable, Equatable, Decodable {
    public var telegram: ChannelNotify?
    public var cliq: ChannelNotify?
    public var telegramSetUp = false
    public var cliqSetUp = false

    public init(telegram: ChannelNotify? = nil, cliq: ChannelNotify? = nil, telegramSetUp: Bool = false, cliqSetUp: Bool = false) {
        self.telegram = telegram; self.cliq = cliq; self.telegramSetUp = telegramSetUp; self.cliqSetUp = cliqSetUp
    }

    enum CodingKeys: String, CodingKey { case telegram, cliq, channels }
    struct Channels: Decodable { var telegram: Bool?; var cliq: Bool? }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        telegram = c.lenient(ChannelNotify.self, .telegram)
        cliq = c.lenient(ChannelNotify.self, .cliq)
        let ch = c.lenient(Channels.self, .channels)
        telegramSetUp = ch?.telegram ?? false
        cliqSetUp = ch?.cliq ?? false
    }

    public subscript(channel: NotifyChannel) -> ChannelNotify? {
        get { channel == .telegram ? telegram : cliq }
        set { if channel == .telegram { telegram = newValue } else { cliq = newValue } }
    }

    public func isSetUp(_ channel: NotifyChannel) -> Bool { channel == .telegram ? telegramSetUp : cliqSetUp }

    /// Channels to show: set up on this Mac and described by the daemon.
    public var shown: [NotifyChannel] { NotifyChannel.allCases.filter { isSetUp($0) && self[$0] != nil } }

    /// Applies `change` optimistically; returns the change that undoes it, or nil when the channel is unknown.
    public mutating func apply(_ change: NotifyChange, to channel: NotifyChannel) -> NotifyChange? {
        guard let current = self[channel] else { return nil }
        self[channel] = current.applying(change)
        return current.reverting(change)
    }

    /// Puts back one key after a failed write, leaving the other keys as the person has since set them.
    public mutating func rollback(_ undo: NotifyChange, on channel: NotifyChannel) {
        guard let current = self[channel] else { return }
        self[channel] = current.applying(undo)
    }
}

public enum NotifyOutcome: Sendable, Equatable {
    case saved(NotifySettings?)
    case outdated
}

public enum NotifyText {
    public static let outdated = "Update Squeak's background service to change notifications."
    public static let footnote = "Quiet hours hold back finishes, questions asked and stuck sessions. Blocked approvals and quota alerts still come through. A held-back message is dropped, not sent later."
    public static let sameTimes = "Quiet hours need different start and end times."

    public static func failure(_ error: Error) -> String {
        switch error as? AdapterError {
        case .daemonDown: "Couldn't change that: the Squeak service isn't running."
        case .tokenMissing, .tokenRejected: "Couldn't change that: Squeak's access token wasn't accepted."
        case .timedOut: "Couldn't change that: it took too long."
        case .http(400): "Couldn't change that: the service didn't accept it."
        default: "Couldn't change that."
        }
    }
}
