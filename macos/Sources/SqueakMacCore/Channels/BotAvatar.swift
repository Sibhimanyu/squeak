import Foundation

/// What the daemon said to `POST /control/telegram/avatar`, mapped to what the Telegram page shows.
public enum BotAvatarOutcome: Sendable, Equatable {
    case done
    /// The daemon's own fixed sentence (400 or 429).
    case refused(String)
    /// 404: a daemon that predates the route.
    case outdated
    /// 503: the daemon has no Telegram bot wired.
    case unavailable
    case failed(String)

    private struct Body: Decodable {
        var error: String?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            error = try? c.decode(String.self, forKey: .error)
        }
        enum Keys: String, CodingKey { case error }
    }

    public static func from(status: Int, body: Data) -> BotAvatarOutcome {
        let parsed = try? JSONDecoder().decode(Body.self, from: body)
        let sentence = parsed?.error?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        switch status {
        case 200..<300: return .done
        case 404: return .outdated
        case 503: return .unavailable
        case 429: return .refused(sentence ?? BotAvatarText.tooSoon)
        case 400: return .refused(sentence ?? BotAvatarText.rejected)
        case 401, 403: return .failed(BotAvatarText.token)
        default: return .failed(BotAvatarText.unexpected)
        }
    }

    public static func from(error: Error) -> BotAvatarOutcome {
        switch error as? AdapterError {
        case .daemonDown: .failed(BotAvatarText.down)
        case .tokenMissing, .tokenRejected: .failed(BotAvatarText.token)
        case .timedOut: .failed(BotAvatarText.slow)
        default: .failed(BotAvatarText.unexpected)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

public enum BotAvatarText {
    public static let done = "Done — it can take a moment to show in Telegram"
    public static let working = "Setting the picture…"
    public static let outdated = "Update Squeak's background service to set the bot picture."
    public static let unavailable = "Telegram isn't connected in the Squeak service yet."
    public static let tooSoon = "Try again in a minute."
    public static let rejected = "Telegram didn't accept the picture."
    public static let down = "The Squeak service isn't running."
    public static let token = "Squeak's access token wasn't accepted."
    public static let slow = "It took too long. Try again."
    public static let unexpected = "Couldn't set the picture."

    /// The one line under the button, nil before the first press.
    public static func line(_ s: BotAvatarState) -> String? {
        switch s {
        case .idle: nil
        case .working: working
        case .done: done
        case .failed(let t): t
        }
    }
}

/// The Telegram page's picture row: idle, in flight, or the last answer. Pure, so the mapping is tested.
public enum BotAvatarState: Sendable, Equatable {
    case idle, working, done
    case failed(String)

    public init(_ outcome: BotAvatarOutcome) {
        switch outcome {
        case .done: self = .done
        case .refused(let t), .failed(let t): self = .failed(t)
        case .outdated: self = .failed(BotAvatarText.outdated)
        case .unavailable: self = .failed(BotAvatarText.unavailable)
        }
    }

    public var isWorking: Bool { self == .working }
    public var isError: Bool { if case .failed = self { true } else { false } }

    /// Only with Telegram configured, and never while a request is out.
    public func canSet(telegramConfigured: Bool) -> Bool { telegramConfigured && !isWorking }
}
