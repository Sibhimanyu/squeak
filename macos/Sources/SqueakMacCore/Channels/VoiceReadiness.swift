import Foundation

/// `natural.readiness`: whether a changed voice is ready for calls. The daemon owns the state machine
/// (`src/voice/voice-readiness.ts`); this decodes it and words it. Every field but `state` and `voice` is optional.
public struct VoiceReadiness: Sendable, Equatable, Decodable {
    public struct Partial: Sendable, Equatable, Decodable {
        public var recorded: Int
        public var total: Int
        public init(recorded: Int, total: Int) { self.recorded = recorded; self.total = total }
    }

    /// "preparing", "ready" or "failed"; anything else draws nothing.
    public var state: String
    /// While preparing: "loading", "recording" or "sending".
    public var step: String?
    public var done: Int?
    public var total: Int?
    public var partial: Partial?
    public var voice: String
    /// Ms since 1970: of the change (preparing) or of becoming ready.
    public var since: Double
    /// The daemon's fixed sentence when failed.
    public var reason: String?

    public init(state: String, step: String? = nil, done: Int? = nil, total: Int? = nil, partial: Partial? = nil,
                voice: String = "", since: Double = 0, reason: String? = nil) {
        self.state = state; self.step = step; self.done = done; self.total = total
        self.partial = partial; self.voice = voice; self.since = since; self.reason = reason
    }

    private enum Keys: String, CodingKey { case state, step, done, total, partial, voice, since, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = try c.decode(String.self, forKey: .state)
        step = try? c.decode(String.self, forKey: .step)
        done = try? c.decode(Int.self, forKey: .done)
        total = try? c.decode(Int.self, forKey: .total)
        partial = try? c.decode(Partial.self, forKey: .partial)
        voice = (try? c.decode(String.self, forKey: .voice)) ?? ""
        since = (try? c.decode(Double.self, forKey: .since)) ?? 0
        reason = try? c.decode(String.self, forKey: .reason)
    }

    public var isPreparing: Bool { state == "preparing" }

    /// How long the "is ready" confirmation stays.
    public static let readyLineSeconds: Double = 60

    public enum Kind: Sendable, Equatable { case preparing, ready, warning }

    /// What to draw: the sentence, how to draw it, and a 0...1 fraction for a progress bar (recording only).
    public struct Line: Sendable, Equatable {
        public var text: String
        public var kind: Kind
        public var fraction: Double?
    }

    /// The one line under the voice controls, or nil when there is nothing to say.
    public func line(now: Date = Date()) -> Line? {
        let name = voice.isEmpty ? "The new voice" : voice
        switch state {
        case "preparing":
            let head = "Getting \(name) ready for calls: "
            switch step {
            case "recording":
                if let done, let total, total > 0 {
                    let d = min(max(done, 0), total)
                    return Line(text: head + "recording call prompts (\(d) of \(total))…", kind: .preparing,
                                fraction: Double(d) / Double(total))
                }
                return Line(text: head + "recording call prompts…", kind: .preparing, fraction: nil)
            case "sending": return Line(text: head + "sending to the phone add-on…", kind: .preparing, fraction: nil)
            default: return Line(text: head + "loading the voice…", kind: .preparing, fraction: nil)
            }
        case "ready":
            if let p = partial, p.total > p.recorded {
                return Line(text: "\(name) is ready for calls; \(p.total - p.recorded) of \(p.total) prompts are still in the add-on's voice until the next update.",
                            kind: .ready, fraction: nil)
            }
            let age = now.timeIntervalSince1970 - since / 1000
            guard age < Self.readyLineSeconds else { return nil }
            return Line(text: "\(name) is ready for calls.", kind: .ready, fraction: nil)
        case "failed":
            return Line(text: reason ?? "The new voice could not start; calls use the add-on's voice.", kind: .warning, fraction: nil)
        default: return nil
        }
    }
}
