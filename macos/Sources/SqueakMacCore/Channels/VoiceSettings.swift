import Foundation

/// Phone calls from Squeak: `GET /control/voice` and `POST /control/voice`. The daemon owns the rules
/// (`src/voice/settings.ts`); this only shapes, validates and carries the one setting, the extension to ring.
public struct VoiceSettings: Sendable, Equatable, Decodable {
    /// "gateway" (the Home Assistant add-on places the call), "direct" (this Mac does) or "off".
    public var mode = "off"
    /// The extension set here; nil until one is.
    public var callee: String?
    /// The extension the daemon's own config or the add-on falls back to.
    public var defaultCallee: String?
    /// "set" / "off" / "none" / "unknown"; nil from a daemon that predates PIN management (hide the section).
    public var pin: String?
    /// When the PIN is asked; nil from a daemon that predates the policy (hide the section).
    public var policy: PinPolicy?

    /// Calls paused: `until` in ms since 1970, nil inside = until turned back on. Nil = not paused.
    public var pause: VoicePause?
    /// True when the daemon sent a `pause` key at all (even null); false from an older daemon (hide the row).
    public var pauseKnown = false

    public init(mode: String = "off", callee: String? = nil, defaultCallee: String? = nil, pin: String? = nil, policy: PinPolicy? = nil,
                pause: VoicePause? = nil, pauseKnown: Bool? = nil) {
        self.mode = mode; self.callee = callee; self.defaultCallee = defaultCallee; self.pin = pin; self.policy = policy
        self.pause = pause; self.pauseKnown = pauseKnown ?? (pause != nil)
    }

    private enum Keys: String, CodingKey { case mode, callee, defaultCallee, pin, policy, pause }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        mode = (try? c.decode(String.self, forKey: .mode)) ?? "off"
        callee = try? c.decode(String.self, forKey: .callee)
        defaultCallee = try? c.decode(String.self, forKey: .defaultCallee)
        pin = try? c.decode(String.self, forKey: .pin)
        policy = try? c.decode(PinPolicy.self, forKey: .policy)
        pauseKnown = c.contains(.pause)
        pause = try? c.decode(VoicePause.self, forKey: .pause)
    }

    public var isOn: Bool { mode != "off" }

    /// An internal extension: 2 to 6 digits. Never an outside number, here or at the daemon.
    public static func isExtension(_ text: String) -> Bool {
        (2...6).contains(text.count) && text.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    /// The text a person typed, trimmed, or nil when it is empty (which clears the setting).
    public static func normalized(_ typed: String) -> String? {
        let t = typed.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : t
    }

    public static func requestBody(callee: String?) -> Data {
        let object: [String: Any] = ["callee": callee as Any? ?? NSNull()]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

/// `pause: { until }`: until is ms since 1970, absent or null = until turned back on.
public struct VoicePause: Sendable, Equatable, Decodable {
    public var until: Double?
    public init(until: Double? = nil) { self.until = until }
    private enum Keys: String, CodingKey { case until }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        until = try? c.decode(Double.self, forKey: .until)
    }
}

/// What the person picks in Pause calls. The daemon computes the end; the app only names the choice.
public enum VoicePauseChoice: String, Sendable, Equatable, CaseIterable {
    case oneHour = "1h", fourHours = "4h", tomorrow, forever, resume

    public var menuTitle: String {
        switch self {
        case .oneHour: "For 1 hour"
        case .fourHours: "For 4 hours"
        case .tomorrow: "Until tomorrow morning"
        case .forever: "Until I turn it back on"
        case .resume: "Resume calls"
        }
    }

    public func requestBody() -> Data {
        (try? JSONSerialization.data(withJSONObject: ["pause": rawValue], options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

public enum PauseText {
    /// "Calls are on" / "Paused until 3:40 PM" / "Paused until you turn it back on". An elapsed end reads as on.
    public static func statusLine(_ pause: VoicePause?, now: Date = Date(),
                                  time: (Date, Date) -> String = PauseText.defaultTime) -> String {
        guard let pause else { return "Calls are on" }
        guard let until = pause.until else { return "Paused until you turn it back on" }
        let end = Date(timeIntervalSince1970: until / 1000)
        if end <= now { return "Calls are on" }
        return "Paused until \(time(end, now))"
    }

    /// Time of day today; with the weekday when it is not today.
    public static func defaultTime(_ end: Date, _ now: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short; f.dateStyle = .none
        let t = f.string(from: end)
        if Calendar.current.isDate(end, inSameDayAs: now) { return t }
        let d = DateFormatter()
        d.setLocalizedDateFormatFromTemplate("EEEE")
        return "\(d.string(from: end)) \(t)"
    }

    public static func isPaused(_ pause: VoicePause?, now: Date = Date()) -> Bool {
        guard let pause else { return false }
        guard let until = pause.until else { return true }
        return Date(timeIntervalSince1970: until / 1000) > now
    }
}
