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

    public init(mode: String = "off", callee: String? = nil, defaultCallee: String? = nil, pin: String? = nil, policy: PinPolicy? = nil) {
        self.mode = mode; self.callee = callee; self.defaultCallee = defaultCallee; self.pin = pin; self.policy = policy
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
