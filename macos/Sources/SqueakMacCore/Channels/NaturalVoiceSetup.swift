import Foundation

/// `GET` / `POST /control/voice/natural/setup`: the daemon installs the realistic voice in the background and this
/// only carries and words its status. The daemon owns the rules and the fixed error sentences (`natural-setup.ts`).
public struct NaturalSetupStatus: Sendable, Equatable, Decodable {
    public enum State: String, Sendable, Equatable { case idle, running, ready, failed }

    public var state: State
    /// "python", "engine", "model", "voices" or "finishing" while running.
    public var step: String?
    /// One plain line from the daemon, e.g. "Downloading the voice model: 120 of 326 MB".
    public var text: String?
    /// 0 to 99 over the whole install while it runs.
    public var percent: Int?
    public var bytes: Double?
    public var totalBytes: Double?
    /// "no-python", "no-network", "no-space" or "failed".
    public var code: String?
    /// The daemon's fixed sentence for a failure.
    public var error: String?
    /// The engine being installed; nil from a daemon without engines (Kokoro).
    public var engine: String?

    public init(state: State, step: String? = nil, text: String? = nil, percent: Int? = nil,
                bytes: Double? = nil, totalBytes: Double? = nil, code: String? = nil, error: String? = nil, engine: String? = nil) {
        self.state = state; self.step = step; self.text = text; self.percent = percent
        self.bytes = bytes; self.totalBytes = totalBytes; self.code = code; self.error = error; self.engine = engine
    }

    private enum Keys: String, CodingKey { case state, step, text, percent, bytes, totalBytes, code, error, engine }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(State.init(rawValue:)) ?? .idle
        step = try? c.decode(String.self, forKey: .step)
        text = try? c.decode(String.self, forKey: .text)
        percent = (try? c.decode(Double.self, forKey: .percent)).map { Int($0.rounded()) }
        bytes = try? c.decode(Double.self, forKey: .bytes)
        totalBytes = try? c.decode(Double.self, forKey: .totalBytes)
        code = try? c.decode(String.self, forKey: .code)
        error = try? c.decode(String.self, forKey: .error)
        engine = try? c.decode(String.self, forKey: .engine)
    }

    public var isRunning: Bool { state == .running }

    /// Whether this status is about the given engine (no engine named = Kokoro).
    public func concerns(_ engineID: String) -> Bool { (engine ?? NaturalVoice.kokoroID) == engineID }

    /// 0...1 for a determinate bar; nil when the daemon gave no percentage.
    public var fraction: Double? {
        guard isRunning, let percent else { return nil }
        return min(1, max(0, Double(percent) / 100))
    }

    /// What to show beside the bar: the daemon's line, with the percentage when it has one.
    public var progressLine: String {
        let line = text?.isEmpty == false ? text! : "Setting up the realistic voice…"
        guard let percent else { return line }
        return "\(line) (\(percent)%)"
    }

    /// The sentence for a failed install; never empty, and the daemon's own words win.
    public var failureLine: String {
        if let error, !error.isEmpty { return error }
        return "The voice could not be installed. Try again."
    }

    /// A failure a retry cannot fix until the person does something first (install Python).
    public var needsPython: Bool { code == "no-python" }
}

public enum NaturalSetupOutcome: Sendable, Equatable {
    /// Started, or already running: the daemon's status.
    case started(NaturalSetupStatus)
    /// The daemon's own sentence (already installed, or it cannot do it).
    case refused(String)
    /// A daemon that predates the routes (404): update Squeak.
    case outdated
}

public enum NaturalSetup {
    public static let requestBody = Data("{}".utf8)

    /// `{}` for Kokoro (what an older daemon expects), `{"engine":"<id>"}` for any other.
    public static func requestBody(engine: String?) -> Data {
        guard let engine, engine != NaturalVoice.kokoroID else { return requestBody }
        return (try? JSONSerialization.data(withJSONObject: ["engine": engine], options: [.sortedKeys])) ?? requestBody
    }

    /// `{"engine":"<id>"}` for `POST /control/voice/natural/remove`.
    public static func removeBody(engine: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["engine": engine], options: [.sortedKeys])) ?? requestBody
    }

    public static let outdatedSentence = "Squeak on this Mac is older than this setting. Update it and try again."
    public static let unreachableSentence = "Squeak on this Mac stopped answering, so the install may not have finished. Try again."
}

public enum NaturalRemoveOutcome: Sendable, Equatable {
    case removed
    /// The daemon's own sentence (the current engine, or the only one, cannot be removed).
    case refused(String)
    case outdated
}
