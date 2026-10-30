import Foundation

/// Telegram and Zoho Cliq setup from the phone (`channelsSetup` in the phone view, `telegram` / `cliq` commands).
/// Protocol: .context/channels-setup-protocol.md; the Mac side is src/squeak/channels-setup.ts.
///
/// Every field is optional-tolerant (an older or newer Mac still decodes) and the view has no field that could carry
/// a secret: only `tokenSet` / `webhookSet`.
public struct ChannelsSetup: Codable, Equatable, Sendable {
    public var telegram: Telegram?
    public var cliq: Cliq?
    public var restarting: Bool?

    public init(telegram: Telegram? = nil, cliq: Cliq? = nil, restarting: Bool? = nil) {
        self.telegram = telegram
        self.cliq = cliq
        self.restarting = restarting
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        telegram = try? c.decodeIfPresent(Telegram.self, forKey: .telegram)
        cliq = try? c.decodeIfPresent(Cliq.self, forKey: .cliq)
        restarting = try? c.decodeIfPresent(Bool.self, forKey: .restarting)
    }

    public struct Telegram: Codable, Equatable, Sendable {
        public var tokenSet: Bool?
        /// `@username` without the @.
        public var bot: String?
        /// "ok", "error" or "off".
        public var polling: String?
        public var lastError: String?
        public var chats: [Chat]?
        /// A token is set but no chat is linked: anyone could message the bot.
        public var open: Bool?
        public var linking: Linking?
        public var testing: Bool?
        public var lastTest: LastTest?

        public init(tokenSet: Bool? = nil, bot: String? = nil, polling: String? = nil, lastError: String? = nil,
                    chats: [Chat]? = nil, open: Bool? = nil, linking: Linking? = nil, testing: Bool? = nil,
                    lastTest: LastTest? = nil) {
            self.tokenSet = tokenSet; self.bot = bot; self.polling = polling; self.lastError = lastError
            self.chats = chats; self.open = open; self.linking = linking; self.testing = testing; self.lastTest = lastTest
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tokenSet = try? c.decodeIfPresent(Bool.self, forKey: .tokenSet)
            bot = try? c.decodeIfPresent(String.self, forKey: .bot)
            polling = try? c.decodeIfPresent(String.self, forKey: .polling)
            lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
            chats = (try? c.decodeIfPresent(Lossy<Chat>.self, forKey: .chats))?.items
            open = try? c.decodeIfPresent(Bool.self, forKey: .open)
            linking = try? c.decodeIfPresent(Linking.self, forKey: .linking)
            testing = try? c.decodeIfPresent(Bool.self, forKey: .testing)
            lastTest = try? c.decodeIfPresent(LastTest.self, forKey: .lastTest)
        }

        public struct Chat: Codable, Equatable, Sendable, Identifiable {
            public var id: Int64
            public var name: String?
            public init(id: Int64, name: String? = nil) { self.id = id; self.name = name }
        }

        public struct Candidate: Codable, Equatable, Sendable, Identifiable {
            public var id: Int64
            public var name: String
            /// "private", "group", "supergroup" or "channel".
            public var type: String
            public init(id: Int64, name: String, type: String) { self.id = id; self.name = name; self.type = type }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = try c.decode(Int64.self, forKey: .id)
                name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
                type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? "private"
            }
        }

        public struct Linking: Codable, Equatable, Sendable {
            public var until: String?
            public var candidates: [Candidate]
            public init(until: String? = nil, candidates: [Candidate] = []) { self.until = until; self.candidates = candidates }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                until = try? c.decodeIfPresent(String.self, forKey: .until)
                candidates = (try? c.decodeIfPresent(Lossy<Candidate>.self, forKey: .candidates))?.items ?? []
            }
        }

        public struct LastTest: Codable, Equatable, Sendable {
            public var at: String?
            public var ok: Bool
            public var sentTo: Int?
            public var reason: String?
            public init(at: String? = nil, ok: Bool, sentTo: Int? = nil, reason: String? = nil) {
                self.at = at; self.ok = ok; self.sentTo = sentTo; self.reason = reason
            }
        }
    }

    public struct Cliq: Codable, Equatable, Sendable {
        public var webhookSet: Bool?
        public var ownerEmail: String?
        public var ownerId: String?
        public var oneWay: Bool?
        public var twoWay: Bool?

        public init(webhookSet: Bool? = nil, ownerEmail: String? = nil, ownerId: String? = nil, oneWay: Bool? = nil, twoWay: Bool? = nil) {
            self.webhookSet = webhookSet; self.ownerEmail = ownerEmail; self.ownerId = ownerId
            self.oneWay = oneWay; self.twoWay = twoWay
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            webhookSet = try? c.decodeIfPresent(Bool.self, forKey: .webhookSet)
            ownerEmail = try? c.decodeIfPresent(String.self, forKey: .ownerEmail)
            ownerId = try? c.decodeIfPresent(String.self, forKey: .ownerId)
            oneWay = try? c.decodeIfPresent(Bool.self, forKey: .oneWay)
            twoWay = try? c.decodeIfPresent(Bool.self, forKey: .twoWay)
        }
    }

    /// An array that drops elements it cannot read instead of failing the whole view.
    struct Lossy<T: Codable & Sendable>: Codable, Sendable {
        var items: [T]
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            var out: [T] = []
            while !c.isAtEnd {
                if let v = try? c.decode(T.self) { out.append(v) } else { _ = try? c.decode(Skip.self) }
            }
            items = out
        }
        func encode(to encoder: Encoder) throws { try items.encode(to: encoder) }
        private struct Skip: Decodable { init(from decoder: Decoder) throws {} }
    }
}

/// One change to Telegram's setup, exactly one key with its exact type. A token never prints: see `description`.
public enum TelegramChange: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case token(String)
    case off
    case startLink
    case stopLink
    /// A chat that is in `linking.candidates`.
    case link(Int64)
    case unlink(Int64)
    case test

    /// The key the Mac reads.
    public var key: String {
        switch self {
        case .token: "token"
        case .off: "off"
        case .startLink: "startLink"
        case .stopLink: "stopLink"
        case .link: "link"
        case .unlink: "unlink"
        case .test: "test"
        }
    }

    /// Owner check (Face ID or passcode) first, for everything but a test and opening or closing the link window.
    public var requiresOwnerCheck: Bool {
        switch self {
        case .test, .startLink, .stopLink: false
        default: true
        }
    }

    /// Whether the Mac restarts its service after taking it.
    public var restartsService: Bool {
        switch self {
        case .token, .off, .link, .unlink: true
        default: false
        }
    }

    /// The words under the system's Face ID sheet.
    public var ownerReason: String {
        switch self {
        case .token: "Change your Telegram bot token"
        case .off: "Turn off Telegram"
        case .link: "Allow a Telegram chat"
        case .unlink: "Remove a Telegram chat"
        default: ""
        }
    }

    /// Never the token.
    public var description: String { "TelegramChange.\(key)" }
    public var debugDescription: String { description }
}

extension TelegramChange: Encodable {
    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ name: String) { stringValue = name }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// `{ "<key>": value }` and nothing else; chat ids are JSON integers.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        let k = Key(key)
        switch self {
        case .token(let v): try c.encode(v, forKey: k)
        case .off, .startLink, .stopLink, .test: try c.encode(true, forKey: k)
        case .link(let id), .unlink(let id): try c.encode(id, forKey: k)
        }
    }
}

/// One change to Zoho Cliq's setup, exactly one key with its exact type. A webhook never prints.
public enum CliqChange: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case webhook(String)
    case removeWebhook
    /// Whose messages Squeak accepts; nil clears that half.
    case owner(email: String?, id: String?)

    public var key: String {
        switch self {
        case .webhook: "webhook"
        case .removeWebhook: "removeWebhook"
        case .owner: "owner"
        }
    }

    /// Every Cliq change is owner-checked.
    public var requiresOwnerCheck: Bool { true }

    public var restartsService: Bool { true }

    public var ownerReason: String {
        switch self {
        case .webhook: "Change your Cliq webhook"
        case .removeWebhook: "Remove your Cliq webhook"
        case .owner: "Change who Cliq accepts messages from"
        }
    }

    public var description: String { "CliqChange.\(key)" }
    public var debugDescription: String { description }
}

extension CliqChange: Encodable {
    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ name: String) { stringValue = name }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// `{ "owner": { "email": ..., "id": ... } }` always carries both keys, null when cleared.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        let k = Key(key)
        switch self {
        case .webhook(let v): try c.encode(v, forKey: k)
        case .removeWebhook: try c.encode(true, forKey: k)
        case .owner(let email, let id):
            var o = c.nestedContainer(keyedBy: Key.self, forKey: k)
            if let email { try o.encode(email, forKey: Key("email")) } else { try o.encodeNil(forKey: Key("email")) }
            if let id { try o.encode(id, forKey: Key("id")) } else { try o.encodeNil(forKey: Key("id")) }
        }
    }
}

/// A signed Telegram setup change. Exactly these keys, no others. Prints without its change (a token).
public struct TelegramSetupCommand: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let v: Int
    public let kind: String
    public let change: TelegramChange
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
    public var description: String { "TelegramSetupCommand(\(change))" }
}

/// A signed Cliq setup change. Exactly these keys, no others. Prints without its change (a webhook).
public struct CliqSetupCommand: Encodable, Equatable, Sendable, CustomStringConvertible {
    public let v: Int
    public let kind: String
    public let change: CliqChange
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
    public var description: String { "CliqSetupCommand(\(change))" }
}

/// The words of the channel setup pages (the Mac's Settings > Channels wording), kept in the core so tests pin them.
public enum ChannelsSetupFormat {
    public static let restartNote = "Saving restarts the Squeak service for a few seconds."
    public static let cancelled = "Face ID was cancelled. Nothing changed."
    public static let noAnswer = "Your Mac didn't answer. Is Squeak running?"
    public static let unreachable = "Couldn't reach your Mac."
    public static let notConnected = "Not connected to your Mac."
    public static let fallbackRefusal = "Your Mac couldn't change that."

    public static let badToken = "That doesn't look like a bot token. It is a number, a colon, then letters and digits."
    public static let badWebhook = "That should be an https link on zoho.com, like the one in the bot's webhook settings."

    public static let turnOffTitle = "Turn off Telegram?"
    public static let turnOffMessage = "Squeak stops sending cards to Telegram. Your linked chats are kept."
    public static let turnOffButton = "Turn off and remove token"
    public static let removeWebhookTitle = "Remove the Cliq webhook?"
    public static let removeWebhookMessage = "Squeak stops sending cards to Cliq."
    public static let removeWebhookButton = "Remove webhook"

    public static let waiting = "Waiting for a message…"
    public static let linkNeedsToken = "Save the bot token first, so Squeak can hear the bot."
    public static let noChats = "No chats linked"
    public static let openWarning = "No chat is linked yet, so anyone who finds your bot could message it. Link a chat."
    public static let repliesOn = "Replies from Cliq are on."
    public static let repliesOff = "To receive replies from Cliq, run the setup command on your Mac."
    public static let pictureDetail = "The duck on Ink, as the bot's profile photo."

    /// The Mac's token check: digits, a colon, then 20 or more letters, digits, `_` or `-`.
    public static func isBotToken(_ s: String) -> Bool {
        let parts = s.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[0].allSatisfy { $0.isASCII && $0.isNumber }
            && parts[1].count >= 20 && parts[1].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    /// The Mac's webhook check: https on a Zoho host.
    public static func isCliqWebhook(_ s: String) -> Bool {
        guard let u = URL(string: s), u.scheme == "https", let host = u.host?.lowercased() else { return false }
        return host == "zoho.com" || host.hasSuffix(".zoho.com") || host.contains(".zoho.") || host.hasPrefix("cliq.zoho.")
    }

    /// What a pasted secret looks like after trimming; never logged.
    public static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The Status card: a line and, when there is one, a detail. `tint` is "ok", "error" or nil.
    public static func telegramStatus(_ t: ChannelsSetup.Telegram, restarting: Bool) -> (text: String, detail: String?, tint: String?) {
        if restarting { return ("Restarting the Squeak service…", nil, nil) }
        guard t.tokenSet == true else { return ("Telegram is not set up", nil, nil) }
        switch t.polling {
        case "ok": return (t.bot.map { "Connected as @\($0)" } ?? "Connected", nil, "ok")
        case "error": return ("Telegram is not connecting", t.lastError, "error")
        default: return ("Telegram is off", nil, nil)
        }
    }

    public static func chatName(_ chat: ChannelsSetup.Telegram.Chat) -> String {
        (chat.name?.isEmpty == false ? chat.name : nil) ?? "Chat"
    }

    public static func candidateDetail(_ c: ChannelsSetup.Telegram.Candidate) -> String {
        "\(c.type == "private" ? "Private chat" : c.type.capitalized) · ID \(c.id)"
    }

    public static func linkSteps(bot: String?) -> [String] {
        ["1. Open Telegram and send any message to \(bot.map { "@\($0)" } ?? "your bot").", "2. Pick the chat below when it appears."]
    }

    public static func cliqStatus(_ c: ChannelsSetup.Cliq) -> String {
        c.twoWay == true ? "Two-way: cards go out and replies come back"
            : c.oneWay == true ? "One-way: cards go out to Cliq" : "Zoho Cliq is not set up"
    }

    /// The line after a test: success, or the Mac's own reason.
    public static func testLine(_ test: ChannelsSetup.Telegram.LastTest) -> String {
        if test.ok {
            let n = test.sentTo ?? 0
            return n == 1 ? "Test message sent to 1 chat." : "Test message sent to \(n) chats."
        }
        return test.reason ?? "The test message didn't arrive."
    }

    /// The line after a command: nil when the Mac took it, else its own fixed reason.
    public static func refusal(for result: CommandResult) -> String? {
        result.sent ? nil : (result.reason ?? fallbackRefusal)
    }
}
