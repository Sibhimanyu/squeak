import Foundation

/// `GET /control/channels`. Every field is optional on the wire; a missing one reads as "unknown".
public struct ChannelsStatus: Decodable, Sendable, Equatable {
    public struct Telegram: Decodable, Sendable, Equatable {
        public enum Polling: String, Sendable { case ok, error, off }
        public var configured: Bool
        public var polling: Polling
        public var lastError: String?
        public var botUsername: String?
        public var allowedChatIds: [Int]
        public var open: Bool

        public init(configured: Bool = false, polling: Polling = .off, lastError: String? = nil, botUsername: String? = nil, allowedChatIds: [Int] = [], open: Bool = false) {
            self.configured = configured; self.polling = polling; self.lastError = lastError
            self.botUsername = botUsername; self.allowedChatIds = allowedChatIds; self.open = open
        }

        enum CodingKeys: String, CodingKey { case configured, polling, lastError, botUsername, allowedChatIds, open }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            configured = c.lenient(Bool.self, .configured) ?? false
            polling = c.lenient(String.self, .polling).flatMap(Polling.init(rawValue:)) ?? .off
            lastError = c.lenient(String.self, .lastError)
            botUsername = c.lenient(String.self, .botUsername)
            allowedChatIds = c.lenient([Int].self, .allowedChatIds) ?? []
            open = c.lenient(Bool.self, .open) ?? false
        }
    }
    public struct Cliq: Decodable, Sendable, Equatable {
        public var oneWay: Bool
        public var twoWay: Bool
        public init(oneWay: Bool = false, twoWay: Bool = false) { self.oneWay = oneWay; self.twoWay = twoWay }
        enum CodingKeys: String, CodingKey { case oneWay, twoWay }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            oneWay = c.lenient(Bool.self, .oneWay) ?? false
            twoWay = c.lenient(Bool.self, .twoWay) ?? false
        }
    }
    public struct Phone: Decodable, Sendable, Equatable {
        public var enabled: Bool
        public init(enabled: Bool = false) { self.enabled = enabled }
        enum CodingKeys: String, CodingKey { case enabled }
        public init(from decoder: Decoder) throws {
            enabled = try decoder.container(keyedBy: CodingKeys.self).lenient(Bool.self, .enabled) ?? false
        }
    }

    public var telegram: Telegram
    public var cliq: Cliq
    public var phone: Phone

    public init(telegram: Telegram = .init(), cliq: Cliq = .init(), phone: Phone = .init()) {
        self.telegram = telegram; self.cliq = cliq; self.phone = phone
    }

    enum CodingKeys: String, CodingKey { case telegram, cliq, phone }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        telegram = c.lenient(Telegram.self, .telegram) ?? .init()
        cliq = c.lenient(Cliq.self, .cliq) ?? .init()
        phone = c.lenient(Phone.self, .phone) ?? .init()
    }
}

/// A chat that has messaged the bot but is not linked yet.
public struct TelegramCandidate: Decodable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var name: String
    public var type: String
    public var at: Date?

    public init(id: Int, name: String, type: String, at: Date? = nil) { self.id = id; self.name = name; self.type = type; self.at = at }

    enum CodingKeys: String, CodingKey { case id, name, type, at }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        type = c.lenient(String.self, .type) ?? "private"
        at = c.lenient(String.self, .at).flatMap(DaemonDate.parse)
    }
}

struct TelegramCandidatesBody: Decodable {
    var chats: [TelegramCandidate]
    enum CodingKeys: String, CodingKey { case chats }
    init(from decoder: Decoder) throws {
        struct Failable: Decodable {
            let value: TelegramCandidate?
            init(from decoder: Decoder) throws { value = try? TelegramCandidate(from: decoder) }
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chats = (c.lenient([Failable].self, .chats) ?? []).compactMap(\.value)
    }
}

public struct TelegramTestResult: Decodable, Sendable, Equatable {
    public var ok: Bool
    public var sentTo: Int
    public var reason: String?
    public init(ok: Bool, sentTo: Int = 0, reason: String? = nil) { self.ok = ok; self.sentTo = sentTo; self.reason = reason }
    enum CodingKeys: String, CodingKey { case ok, sentTo, reason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, .ok) ?? false
        sentTo = c.lenient(Int.self, .sentTo) ?? 0
        reason = c.lenient(String.self, .reason)
    }
}

/// `GET /control/remote/status` (RemoteBridge.status, plus `available`).
public struct RemoteStatus: Decodable, Sendable, Equatable {
    public struct Device: Decodable, Sendable, Equatable, Identifiable {
        public var id: String
        public var name: String
        public var pairedAt: Date?
        public var revokedAt: Date?
        public init(id: String, name: String, pairedAt: Date? = nil, revokedAt: Date? = nil) {
            self.id = id; self.name = name; self.pairedAt = pairedAt; self.revokedAt = revokedAt
        }
        enum CodingKeys: String, CodingKey { case id, name, pairedAt, revokedAt }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = c.lenient(String.self, .name) ?? "iPhone"
            pairedAt = c.lenient(String.self, .pairedAt).flatMap(DaemonDate.parse)
            revokedAt = c.lenient(String.self, .revokedAt).flatMap(DaemonDate.parse)
        }
    }
    public struct Pending: Decodable, Sendable, Equatable, Identifiable {
        public var id: String
        public var name: String
        public var code: String
        public var requestedAt: Date?
        public init(id: String, name: String, code: String, requestedAt: Date? = nil) {
            self.id = id; self.name = name; self.code = code; self.requestedAt = requestedAt
        }
        enum CodingKeys: String, CodingKey { case id, name, code, requestedAt }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = c.lenient(String.self, .name) ?? "iPhone"
            code = c.lenient(String.self, .code) ?? ""
            requestedAt = c.lenient(String.self, .requestedAt).flatMap(DaemonDate.parse)
        }
    }

    /// False when the daemon has no phone channel (no SQUEAK_REMOTE_PROJECT).
    public var available: Bool
    public var configured: Bool
    public var phoneOpen: Bool
    public var pairingOpen: Bool
    public var devices: [Device]
    public var pending: [Pending]
    /// Only a daemon on Squeak's shared server says these.
    public var shared: Bool?
    public var usedBytes: Int?
    public var budgetBytes: Int?
    public var pausedUntil: Date?

    public var activeDevices: [Device] { devices.filter { $0.revokedAt == nil } }

    public init(available: Bool = true, configured: Bool = false, phoneOpen: Bool = false, pairingOpen: Bool = false, devices: [Device] = [], pending: [Pending] = [],
                shared: Bool? = nil, usedBytes: Int? = nil, budgetBytes: Int? = nil, pausedUntil: Date? = nil) {
        self.shared = shared; self.usedBytes = usedBytes; self.budgetBytes = budgetBytes; self.pausedUntil = pausedUntil
        self.available = available; self.configured = configured; self.phoneOpen = phoneOpen
        self.pairingOpen = pairingOpen; self.devices = devices; self.pending = pending
    }

    enum CodingKeys: String, CodingKey { case available, configured, phoneOpen, pairingOpen, devices, pending, shared, usedBytes, budgetBytes, pausedUntil }
    public init(from decoder: Decoder) throws {
        struct Failable<T: Decodable>: Decodable {
            let value: T?
            init(from decoder: Decoder) throws { value = try? T(from: decoder) }
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = c.lenient(Bool.self, .available) ?? true
        configured = c.lenient(Bool.self, .configured) ?? false
        phoneOpen = c.lenient(Bool.self, .phoneOpen) ?? false
        pairingOpen = c.lenient(Bool.self, .pairingOpen) ?? false
        devices = (c.lenient([Failable<Device>].self, .devices) ?? []).compactMap(\.value)
        pending = (c.lenient([Failable<Pending>].self, .pending) ?? []).compactMap(\.value)
        shared = c.lenient(Bool.self, .shared)
        usedBytes = c.lenient(Int.self, .usedBytes)
        budgetBytes = c.lenient(Int.self, .budgetBytes)
        if let text = c.lenient(String.self, .pausedUntil) {
            pausedUntil = DaemonDate.parse(text)
        } else if let n = c.lenient(Double.self, .pausedUntil) {
            pausedUntil = Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n)
        }
    }
}

/// The QR payload. The URL is the one secret that lets a phone read: never log it.
public struct RemotePairing: Decodable, Sendable, Equatable {
    public var url: String
    /// Where Squeak for Web takes the same code, pasted as text.
    public static let webAppAddress = "squeak-mac.web.app"
}
