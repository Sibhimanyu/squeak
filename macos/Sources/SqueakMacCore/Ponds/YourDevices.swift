import Foundation

/// One of the account's devices, as the daemon lists it for Settings › Your devices. Devices belong to the account, never to a
/// Pond: nothing here is read from, or drawn in, any Pond. The app draws what the daemon sends and decides nothing.
public struct AccountDevice: Identifiable, Equatable, Sendable, Decodable {
    public enum Kind: String, Sendable, Equatable {
        case mac, web, iphone

        public var word: String {
            switch self { case .mac: "Mac"; case .web: "Browser"; case .iphone: "iPhone" }
        }
        public var symbol: String {
            switch self { case .mac: "laptopcomputer"; case .web: "globe"; case .iphone: "iphone.gen3" }
        }
    }

    public var id: String { deviceId }
    public var deviceId: String
    public var name: String
    public var kind: Kind
    public var createdAt: Date?
    public var lastSeenAt: Date?
    public var thisDevice: Bool

    enum CodingKeys: String, CodingKey { case deviceId, name, kind, createdAt, lastSeenAt, thisDevice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        name = c.lenient(String.self, .name) ?? ""
        kind = c.lenient(String.self, .kind).flatMap(Kind.init(rawValue:)) ?? .mac
        createdAt = PondTime.decode(c, .createdAt)
        lastSeenAt = PondTime.decode(c, .lastSeenAt)
        thisDevice = c.lenient(Bool.self, .thisDevice) ?? false
    }

    public init(deviceId: String, name: String, kind: Kind = .mac, createdAt: Date? = nil, lastSeenAt: Date? = nil, thisDevice: Bool = false) {
        self.deviceId = deviceId; self.name = name; self.kind = kind
        self.createdAt = createdAt; self.lastSeenAt = lastSeenAt; self.thisDevice = thisDevice
    }
}

public struct AccountDeviceRow: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var symbol: String
    public var line: String
    /// The device in use is never removed from itself: sign out instead.
    public var canRemove: Bool
}

public enum YourDevices {
    /// This device first, then the others by when they were last seen, newest first.
    public static func rows(_ devices: [AccountDevice], calendar: Calendar = .current, locale: Locale = Locale(identifier: "en_GB")) -> [AccountDeviceRow] {
        let f = DateFormatter()
        f.locale = locale; f.calendar = calendar; f.timeZone = calendar.timeZone
        f.dateFormat = "d MMM yyyy"
        return devices.sorted {
            if $0.thisDevice != $1.thisDevice { return $0.thisDevice }
            switch ($0.lastSeenAt, $1.lastSeenAt) {
            case let (a?, b?): return a == b ? $0.name < $1.name : a > b
            case (_?, nil): return true
            case (nil, _?): return false
            default: return $0.name < $1.name
            }
        }.map { d in
            let line: String
            if d.thisDevice { line = "This \(d.kind.word)" }
            else if let seen = d.lastSeenAt { line = "\(d.kind.word) \u{00B7} last seen \(f.string(from: seen))" }
            else { line = d.kind.word }
            return AccountDeviceRow(id: d.deviceId, name: d.name.isEmpty ? d.kind.word : d.name, symbol: d.kind.symbol, line: line, canRemove: !d.thisDevice)
        }
    }

    public static let title = "Your devices"
    public static let subtitle = "Every Mac, browser and iPhone signed in to your account, for all your Ponds."
    public static let loadFailed = "Squeak couldn't load your devices. Try again."
    public static let signedOut = "Sign in to see the devices on your account."
    public static let footnote = "A new device appears here by itself when you sign in on it. Removing one takes it out of every Pond."

    /// The confirm behind Remove.
    public static func removeMessage(name: String) -> String {
        "\(name) is removed from your account and from every Pond at once. Each Pond\u{2019}s key changes when its Owner\u{2019}s Mac is next online."
    }
}
