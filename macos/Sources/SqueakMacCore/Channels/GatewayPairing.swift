import Foundation

/// The phone-call gateway (the Home Assistant add-on): `GET /control/voice/gateway`,
/// `POST /control/voice/gateway/pair` and `/approve`. The daemon owns the rules; this only decodes
/// tolerantly and words the status in plain sentences. Times are milliseconds since 1970.
public enum GatewayPairState: String, Sendable, Equatable {
    case waiting, request, done, expired
}

public enum GatewayStatusState: String, Sendable, Equatable {
    case none, stale, ok, sipDown
}

public struct GatewayPairing: Sendable, Equatable, Decodable {
    public var state: GatewayPairState
    public var expiresAt: Double?
    public var name: String?
    public var version: String?
    public var verify: String?

    public init(state: GatewayPairState, expiresAt: Double? = nil, name: String? = nil, version: String? = nil, verify: String? = nil) {
        self.state = state; self.expiresAt = expiresAt; self.name = name; self.version = version; self.verify = verify
    }

    private enum Keys: String, CodingKey { case state, expiresAt, name, version, verify }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // An unknown state reads as the safest one: nothing to approve.
        state = (try? c.decode(String.self, forKey: .state)).flatMap(GatewayPairState.init(rawValue:)) ?? .waiting
        expiresAt = try? c.decode(Double.self, forKey: .expiresAt)
        name = try? c.decode(String.self, forKey: .name)
        version = try? c.decode(String.self, forKey: .version)
        verify = try? c.decode(String.self, forKey: .verify)
    }
}

public struct GatewayStatus: Sendable, Equatable, Decodable {
    public var state: GatewayStatusState
    public var version: String?
    public var sipRegistered: Bool?
    public var sipError: String?
    public var at: Double?

    public init(state: GatewayStatusState = .none, version: String? = nil, sipRegistered: Bool? = nil, sipError: String? = nil, at: Double? = nil) {
        self.state = state; self.version = version; self.sipRegistered = sipRegistered; self.sipError = sipError; self.at = at
    }

    private enum Keys: String, CodingKey { case state, version, sipRegistered, sipError, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(GatewayStatusState.init(rawValue:)) ?? .none
        version = try? c.decode(String.self, forKey: .version)
        sipRegistered = try? c.decode(Bool.self, forKey: .sipRegistered)
        sipError = try? c.decode(String.self, forKey: .sipError)
        at = try? c.decode(Double.self, forKey: .at)
    }
}

public struct GatewayView: Sendable, Equatable, Decodable {
    public var pairing: GatewayPairing?
    public var status: GatewayStatus

    public init(pairing: GatewayPairing? = nil, status: GatewayStatus = GatewayStatus()) {
        self.pairing = pairing; self.status = status
    }

    private enum Keys: String, CodingKey { case pairing, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        pairing = try? c.decode(GatewayPairing.self, forKey: .pairing)
        status = (try? c.decode(GatewayStatus.self, forKey: .status)) ?? GatewayStatus()
    }

    /// True once a gateway has ever reported in, so the button reads "Pair again".
    public var isPaired: Bool { status.state != .none }

    /// One plain sentence for the status line.
    public func statusLine(now: Date = Date()) -> String { GatewayText.statusLine(status, now: now) }
}

/// `POST /control/voice/gateway/pair` answer.
public struct GatewayPairResponse: Sendable, Equatable, Decodable {
    public var ok: Bool
    public var code: String
    public var expiresAt: Double

    public init(ok: Bool, code: String, expiresAt: Double) { self.ok = ok; self.code = code; self.expiresAt = expiresAt }
}

public enum GatewayText {
    public static func statusLine(_ s: GatewayStatus, now: Date = Date()) -> String {
        let addon = s.version.map { "Home Assistant add-on \($0)" } ?? "Home Assistant add-on"
        switch s.state {
        case .none:
            return "No gateway paired yet"
        case .ok:
            return "\(addon) · connected"
        case .stale:
            if let at = s.at {
                let minutes = max(1, Int((now.timeIntervalSince1970 - at / 1000) / 60))
                return "Not heard from in \(duration(minutes: minutes))"
            }
            return "Not heard from lately"
        case .sipDown:
            if let e = s.sipError, !e.trimmingCharacters(in: .whitespaces).isEmpty {
                return "Add-on can't reach your PBX: \(e)"
            }
            return "Add-on can't reach your PBX"
        }
    }

    static func duration(minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60
        if h < 48 { return h == 1 ? "1 hour" : "\(h) hours" }
        return "\(h / 24) days"
    }

    /// "9:41" style countdown, or nil once it has passed.
    public static func countdown(expiresAt: Double, now: Date = Date()) -> String? {
        let left = Int((expiresAt / 1000 - now.timeIntervalSince1970).rounded(.up))
        if left <= 0 { return nil }
        return String(format: "%d:%02d", left / 60, left % 60)
    }

    public static func requestSentence(_ p: GatewayPairing) -> String {
        let who = "Squeak Voice" + (p.version.map { " (add-on \($0))" } ?? "")
        let check = p.verify.map { "Confirm \($0) matches the number in the add-on's log." } ?? "Confirm it is yours."
        return "\(who) wants to connect. \(check)"
    }

    public static func approveBody(_ approve: Bool) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["approve": approve], options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}
