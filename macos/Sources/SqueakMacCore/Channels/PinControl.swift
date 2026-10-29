import Foundation

/// The call PIN's own state, as the daemon's voice view says it (never the PIN itself).
public enum PinState: String, Sendable, Equatable {
    case set, off, none, unknown
}

extension VoiceSettings {
    /// nil when the daemon predates PIN management (or says something unknown): the section stays hidden.
    public var pinState: PinState? { pin.flatMap(PinState.init(rawValue:)) }
}

/// Whether the PIN is asked for one kind of call. Anything the daemon says that is not "skip" reads as ask.
public enum PinPolicyChoice: String, Sendable, Equatable, CaseIterable {
    case ask, skip

    public init(daemon raw: String?) { self = raw == "skip" ? .skip : .ask }
}

/// The daemon's `policy: { outgoing, incoming }`: outgoing = calls Squeak makes to you, incoming = calls you make to Squeak.
public struct PinPolicy: Sendable, Equatable, Decodable {
    public var outgoing: PinPolicyChoice
    public var incoming: PinPolicyChoice

    public init(outgoing: PinPolicyChoice = .ask, incoming: PinPolicyChoice = .ask) {
        self.outgoing = outgoing; self.incoming = incoming
    }

    private enum Keys: String, CodingKey { case outgoing, incoming }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        outgoing = PinPolicyChoice(daemon: try? c.decodeIfPresent(String.self, forKey: .outgoing))
        incoming = PinPolicyChoice(daemon: try? c.decodeIfPresent(String.self, forKey: .incoming))
    }
}

/// `POST /control/voice` body `{ "pin": { "action": ... } }`, exactly per the PIN contract.
public enum PinAction: Sendable, Equatable {
    case change(current: String, next: String)
    case disable(current: String)
    case enable(next: String)
    /// `next == nil` turns the PIN requirement off. Only after the owner check (Touch ID / login password).
    case reset(next: String?)
    /// Needs no current PIN; "skip" only after the owner check.
    case policy(outgoing: PinPolicyChoice, incoming: PinPolicyChoice)

    public func requestBody() -> Data {
        var inner: [String: Any]
        switch self {
        case let .change(c, n): inner = ["action": "change", "current": c, "next": n]
        case let .disable(c): inner = ["action": "disable", "current": c]
        case let .enable(n): inner = ["action": "enable", "next": n]
        case let .policy(o, i): inner = ["action": "policy", "outgoing": o.rawValue, "incoming": i.rawValue]
        case let .reset(n): inner = ["action": "reset", "next": n as Any? ?? NSNull()]
        }
        return (try? JSONSerialization.data(withJSONObject: ["pin": inner], options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

public enum PinOutcome: Sendable, Equatable {
    case done(VoiceSettings?)
    case refused(String)
    case outdated

    /// The daemon's fixed sentence from `{ "error": reason }`, or a generic one.
    static func reason(from body: Data) -> String {
        let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let r = (o?["error"] as? String) ?? (o?["reason"] as? String)
        return (r?.isEmpty == false ? r : nil) ?? "Squeak could not do that."
    }
}

public enum PinRules {
    /// 4 to 12 digits, ASCII only.
    public static func isValid(_ pin: String) -> Bool {
        (4...12).contains(pin.count) && pin.allSatisfy { $0 >= "0" && $0 <= "9" }
    }

    /// A sentence for the first thing wrong with a new PIN, or nil when it can be sent.
    public static func problem(new: String, repeated: String) -> String? {
        if !isValid(new) { return "A PIN is 4 to 12 digits." }
        if new != repeated { return "The two new PINs do not match." }
        return nil
    }
}
