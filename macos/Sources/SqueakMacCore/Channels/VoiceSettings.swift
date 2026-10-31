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
    /// The realistic voice this Mac makes for calls; nil from a daemon that predates it (hide the row).
    public var natural: NaturalVoice?
    /// Quick workspaces (keypad number to workspace); nil from a daemon that predates them (hide the section).
    public var favorites: [FavoriteWorkspace]?
    /// Workspaces a favourite can be picked from; nil from an older daemon.
    public var workspaces: [WorkspaceChoice]?
    /// The newest test call ("Call me now"); nil until one has been asked for, or from an older daemon.
    public var lastTest: LastTest?
    /// How the call's assistant speaks; nil from a daemon that predates it (hide the section).
    public var persona: VoicePersona?

    public struct LastTest: Sendable, Equatable, Decodable {
        public var at: Double
        /// "ringing", "answered", "unanswered" or "failed".
        public var status: String
        public var letter: String?
        public var reason: String?
        /// How the line was on an answered call; nil from an older add-on, Mac or daemon.
        public var quality: LineQuality?
        public init(at: Double = 0, status: String, letter: String? = nil, reason: String? = nil, quality: LineQuality? = nil) {
            self.at = at; self.status = status; self.letter = letter; self.reason = reason; self.quality = quality
        }
        private enum Keys: String, CodingKey { case at, status, letter, reason, quality }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            at = (try? c.decode(Double.self, forKey: .at)) ?? 0
            status = (try? c.decode(String.self, forKey: .status)) ?? ""
            letter = try? c.decode(String.self, forKey: .letter)
            reason = try? c.decode(String.self, forKey: .reason)
            quality = try? c.decode(LineQuality.self, forKey: .quality)
        }
    }

    /// The call's line: a verdict ("good", "fair" or "poor") and the numbers behind it, each optional.
    public struct LineQuality: Sendable, Equatable, Decodable {
        public var verdict: String
        public var jitterMs: Double?
        public var lossPct: Double?
        public var rttMs: Double?
        public init(verdict: String, jitterMs: Double? = nil, lossPct: Double? = nil, rttMs: Double? = nil) {
            self.verdict = verdict; self.jitterMs = jitterMs; self.lossPct = lossPct; self.rttMs = rttMs
        }
    }

    public init(mode: String = "off", callee: String? = nil, defaultCallee: String? = nil, pin: String? = nil, policy: PinPolicy? = nil,
                pause: VoicePause? = nil, pauseKnown: Bool? = nil) {
        self.mode = mode; self.callee = callee; self.defaultCallee = defaultCallee; self.pin = pin; self.policy = policy
        self.pause = pause; self.pauseKnown = pauseKnown ?? (pause != nil)
    }

    private enum Keys: String, CodingKey { case mode, callee, defaultCallee, pin, policy, pause, natural, favorites, workspaces, lastTest, persona }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        mode = (try? c.decode(String.self, forKey: .mode)) ?? "off"
        callee = try? c.decode(String.self, forKey: .callee)
        defaultCallee = try? c.decode(String.self, forKey: .defaultCallee)
        pin = try? c.decode(String.self, forKey: .pin)
        policy = try? c.decode(PinPolicy.self, forKey: .policy)
        pauseKnown = c.contains(.pause)
        pause = try? c.decode(VoicePause.self, forKey: .pause)
        natural = try? c.decode(NaturalVoice.self, forKey: .natural)
        favorites = try? c.decode([FavoriteWorkspace].self, forKey: .favorites)
        workspaces = try? c.decode([WorkspaceChoice].self, forKey: .workspaces)
        lastTest = try? c.decode(LastTest.self, forKey: .lastTest)
        persona = try? c.decode(VoicePersona.self, forKey: .persona)
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

    /// The same words the iPhone and the web say about the last test call; nil before any test.
    public static func testLine(_ test: LastTest?) -> String? {
        guard let test else { return nil }
        switch test.status {
        case "ringing": return "Ringing your phone…"
        case "answered":
            let base = test.letter.map { "You answered and pressed \($0). Nothing was sent anywhere." } ?? "You answered. No key was pressed."
            guard let q = test.quality, ["good", "fair", "poor"].contains(q.verdict) else { return base }
            return "\(base) Line quality: \(q.verdict)."
        case "unanswered": return "Nobody picked up."
        case "failed": return "The call failed: \(test.reason ?? "no reason given")"
        default: return nil
        }
    }

    public var isRinging: Bool { lastTest?.status == "ringing" }

    /// Why "Call me now" cannot be pressed (the footnote's own sentences), or nil when it can.
    public var testBlockedReason: String? {
        if !isOn { return "Phone calls are not set up on this Mac." }
        if callee == nil && defaultCallee == nil { return "No extension is set yet, so no call can be placed." }
        return nil
    }

    /// `{ "test": true }`: a test call, ringing with a made-up question and touching no chat.
    public static func testRequestBody() -> Data {
        (try? JSONSerialization.data(withJSONObject: ["test": true], options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    public static func requestBody(callee: String?) -> Data {
        let object: [String: Any] = ["callee": callee as Any? ?? NSNull()]
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

/// How the call's assistant speaks (`persona: { style, custom? }`). These calls are to you, not to a customer, so the
/// default is terse: no greeting, no thanks, no offers of more help. The daemon owns the rules and the wording.
public struct VoicePersona: Sendable, Equatable, Decodable {
    public enum Style: String, Sendable, CaseIterable, Identifiable {
        case terse, friendly, custom
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .terse: return "Terse"
            case .friendly: return "Friendly"
            case .custom: return "Custom"
            }
        }
        public var summary: String {
            switch self {
            case .terse: return "No greetings or thanks. Short and direct, like a teammate on a quick call."
            case .friendly: return "Warm and polite, with a greeting at the start of a call."
            case .custom: return "Describe the character yourself."
            }
        }
    }

    /// Longest custom description the daemon keeps.
    public static let maxCustomLength = 300

    public var style: Style
    public var custom: String

    public init(style: Style = .terse, custom: String = "") { self.style = style; self.custom = custom }

    private enum Keys: String, CodingKey { case style, custom }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        style = (try? c.decode(String.self, forKey: .style)).flatMap(Style.init(rawValue:)) ?? .terse
        custom = (try? c.decode(String.self, forKey: .custom)) ?? ""
    }

    /// The description as it will be sent: whitespace collapsed, clipped to what the daemon keeps.
    public static func cleaned(_ typed: String) -> String {
        String(typed.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(maxCustomLength))
    }

    /// Whether this can be saved: a custom character needs its description.
    public var isSavable: Bool { style != .custom || !Self.cleaned(custom).isEmpty }

    /// `{ "persona": { "style": …, "custom": … } }`; the description only travels with the custom style.
    public func requestBody() -> Data {
        var inner: [String: Any] = ["style": style.rawValue]
        if style == .custom { inner["custom"] = Self.cleaned(custom) }
        return (try? JSONSerialization.data(withJSONObject: ["persona": inner], options: [.sortedKeys])) ?? Data("{}".utf8)
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

/// One voice an engine can speak with: its id (what the daemon accepts) and the label to show.
public struct NaturalVoiceOption: Sendable, Equatable, Decodable, Identifiable, Hashable {
    public var id: String
    public var label: String
    public init(id: String, label: String? = nil) { self.id = id; self.label = label ?? id }

    private enum Keys: String, CodingKey { case id, label }

    public init(from decoder: Decoder) throws {
        // A bare string is also an id (an older daemon listed names only).
        if let single = try? decoder.singleValueContainer().decode(String.self) { id = single; label = single; return }
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decode(String.self, forKey: .label)) ?? id
    }
}

/// How strongly an expressive engine colours a line's mood. The daemon owns the mapping; the app only names it.
public enum NaturalEmotion: String, Sendable, CaseIterable, Identifiable {
    case off, subtle, strong
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .off: "Off"
        case .subtle: "Subtle"
        case .strong: "Strong"
        }
    }
}

/// One speech engine in `natural.engines`. Everything here is the daemon's word; nothing is computed in the app.
public struct NaturalEngine: Sendable, Equatable, Decodable, Identifiable, Hashable {
    public var id: String
    public var label: String
    public var summary: String
    /// "about 3 GB"; nil when the daemon gave none.
    public var size: String?
    public var installed: Bool
    /// Whether the engine has an emotion control (Kokoro does not).
    public var emotion: Bool
    public var voices: [NaturalVoiceOption]
    /// The voice this engine speaks with now.
    public var voice: String?
    public var licence: String?

    public init(id: String, label: String? = nil, summary: String = "", size: String? = nil, installed: Bool = false,
                emotion: Bool = false, voices: [NaturalVoiceOption] = [], voice: String? = nil, licence: String? = nil) {
        self.id = id; self.label = label ?? id; self.summary = summary; self.size = size; self.installed = installed
        self.emotion = emotion; self.voices = voices; self.voice = voice; self.licence = licence
    }

    private enum Keys: String, CodingKey { case id, label, summary, size, installed, emotion, voices, voice, licence }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        label = (try? c.decode(String.self, forKey: .label)) ?? id
        summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
        size = try? c.decode(String.self, forKey: .size)
        installed = (try? c.decode(Bool.self, forKey: .installed)) ?? false
        emotion = (try? c.decode(Bool.self, forKey: .emotion)) ?? false
        voices = (try? c.decode([NaturalVoiceOption].self, forKey: .voices)) ?? []
        voice = try? c.decode(String.self, forKey: .voice)
        licence = try? c.decode(String.self, forKey: .licence)
    }

    /// The voice to pick first: the engine's own, else its first.
    public var defaultVoice: String? { voice ?? voices.first?.id }
}

/// `natural`: the realistic voice this Mac makes (`squeak voice-tts-setup` installs it); the daemon owns the rules.
/// A daemon that predates engines sends none of `engine`, `emotion`, `engines`: that is Kokoro alone, as before.
public struct NaturalVoice: Sendable, Equatable, Decodable {
    public var installed: Bool
    public var enabled: Bool
    public var voice: String
    /// The current engine's id; nil from a daemon without engines (Kokoro).
    public var engine: String?
    /// "off", "subtle" or "strong"; nil from a daemon without engines.
    public var emotion: String?
    /// Every engine the daemon knows; empty from a daemon without engines.
    public var engines: [NaturalEngine]
    /// The current engine's voices; empty from an older daemon (Kokoro's list below stands in).
    public var voices: [NaturalVoiceOption]
    /// Whether a changed voice is ready for calls yet; nil from a daemon that predates it (no line).
    public var readiness: VoiceReadiness?

    public init(installed: Bool, enabled: Bool, voice: String, engine: String? = nil, emotion: String? = nil,
                engines: [NaturalEngine] = [], voices: [NaturalVoiceOption] = [], readiness: VoiceReadiness? = nil) {
        self.installed = installed; self.enabled = enabled; self.voice = voice
        self.engine = engine; self.emotion = emotion; self.engines = engines; self.voices = voices
        self.readiness = readiness
    }

    private enum Keys: String, CodingKey { case installed, enabled, voice, engine, emotion, engines, voices, readiness }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        installed = try c.decode(Bool.self, forKey: .installed)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        voice = try c.decode(String.self, forKey: .voice)
        engine = try? c.decode(String.self, forKey: .engine)
        emotion = try? c.decode(String.self, forKey: .emotion)
        engines = (try? c.decode([NaturalEngine].self, forKey: .engines)) ?? []
        voices = (try? c.decode([NaturalVoiceOption].self, forKey: .voices)) ?? []
        readiness = try? c.decode(VoiceReadiness.self, forKey: .readiness)
    }

    /// A few of Kokoro's English voices; the daemon accepts any Kokoro name. Used only without a daemon list.
    public static let voices: [(id: String, title: String)] = [
        ("af_heart", "Heart (female)"), ("af_bella", "Bella (female)"), ("af_nicole", "Nicole (female)"),
        ("bf_emma", "Emma (British female)"), ("am_michael", "Michael (male)"), ("am_adam", "Adam (male)"),
        ("bm_george", "George (British male)"),
    ]

    public static let kokoroID = "kokoro"

    /// True when the daemon listed engines; false = today's Kokoro-only view.
    public var hasEngines: Bool { !engines.isEmpty }

    public var currentEngineID: String { engine ?? Self.kokoroID }

    public func engine(_ id: String) -> NaturalEngine? { engines.first { $0.id == id } }

    public var currentEngine: NaturalEngine? { engine(currentEngineID) }

    /// The voices to offer for an engine: the daemon's list, else (current engine, or Kokoro) what is known.
    public func voiceOptions(for engineID: String) -> [NaturalVoiceOption] {
        if let listed = engine(engineID)?.voices, !listed.isEmpty { return listed }
        if engineID == currentEngineID, !voices.isEmpty { return voices }
        if engineID == Self.kokoroID { return Self.voices.map { NaturalVoiceOption(id: $0.id, label: $0.title) } }
        return []
    }

    /// The voice an engine speaks with now (the current engine's top-level `voice`).
    public func voice(for engineID: String) -> String? {
        engineID == currentEngineID ? voice : engine(engineID)?.defaultVoice
    }

    /// Whether the emotion picker shows for an engine: only when the daemon says it has one.
    public func hasEmotion(_ engineID: String) -> Bool { engine(engineID)?.emotion ?? false }

    /// The emotion level in force; "subtle" when the daemon said nothing or something unknown.
    public var emotionLevel: NaturalEmotion { emotion.flatMap(NaturalEmotion.init(rawValue:)) ?? .subtle }

    /// Sentence under the engine list for Kokoro-like engines with no emotion control.
    public static let noEmotionSentence = "This engine has no emotion control."

    /// `{ "natural": { enabled?, voice?, engine?, emotion? } }`: only what changed.
    public static func requestBody(enabled: Bool? = nil, voice: String? = nil, engine: String? = nil,
                                   emotion: NaturalEmotion? = nil) -> Data {
        var inner: [String: Any] = [:]
        if let enabled { inner["enabled"] = enabled }
        if let voice { inner["voice"] = voice }
        if let engine { inner["engine"] = engine }
        if let emotion { inner["emotion"] = emotion.rawValue }
        return (try? JSONSerialization.data(withJSONObject: ["natural": inner], options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

/// A workspace a call can pick with one key: `n` is the keypad number 1-9.
public struct FavoriteWorkspace: Sendable, Equatable, Decodable, Identifiable {
    public var n: Int
    public var workspace: String
    public var label: String
    public var id: Int { n }

    public init(n: Int, workspace: String, label: String = "") { self.n = n; self.workspace = workspace; self.label = label }

    private enum Keys: String, CodingKey { case n, workspace, label }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        n = (try? c.decode(Int.self, forKey: .n)) ?? 0
        workspace = (try? c.decode(String.self, forKey: .workspace)) ?? ""
        label = (try? c.decode(String.self, forKey: .label)) ?? workspace
    }
}

public struct WorkspaceChoice: Sendable, Equatable, Decodable, Identifiable, Hashable {
    public var key: String
    public var label: String
    public var id: String { key }

    public init(key: String, label: String) { self.key = key; self.label = label }

    private enum Keys: String, CodingKey { case key, label }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = (try? c.decode(String.self, forKey: .key)) ?? ""
        label = (try? c.decode(String.self, forKey: .label)) ?? key
    }
}

public enum QuickWorkspaces {
    public static let numbers = Array(1...9)

    /// Body of the POST that replaces the whole list: exactly `{"favorites":[{"n":1,"workspace":"<key>"}]}`.
    public static func requestBody(_ list: [FavoriteWorkspace]) -> Data {
        let items: [[String: Any]] = list.map { ["n": $0.n, "workspace": $0.workspace] }
        return (try? JSONSerialization.data(withJSONObject: ["favorites": items], options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    /// Numbers a row may take: its own plus every number no other row holds.
    public static func availableNumbers(for row: Int, in list: [FavoriteWorkspace]) -> [Int] {
        let others = Set(list.filter { $0.n != row }.map(\.n))
        return numbers.filter { $0 == row || !others.contains($0) }
    }

    public static func nextFreeNumber(in list: [FavoriteWorkspace]) -> Int? {
        let used = Set(list.map(\.n))
        return numbers.first { !used.contains($0) }
    }

    /// Moves a row to another number; refused (nil) when another row already holds it or it is outside 1-9.
    public static func renumbered(_ list: [FavoriteWorkspace], from n: Int, to new: Int) -> [FavoriteWorkspace]? {
        guard numbers.contains(new), n == new || !list.contains(where: { $0.n == new }) else { return nil }
        return list.map { $0.n == n ? FavoriteWorkspace(n: new, workspace: $0.workspace, label: $0.label) : $0 }.sorted { $0.n < $1.n }
    }

    /// Adds the first candidate not already used at the lowest free number; nil when none is left or 9 are used.
    public static func added(_ list: [FavoriteWorkspace], candidates: [WorkspaceChoice]) -> [FavoriteWorkspace]? {
        guard let n = nextFreeNumber(in: list),
              let w = candidates.first(where: { c in !list.contains { $0.workspace == c.key } }) else { return nil }
        return (list + [FavoriteWorkspace(n: n, workspace: w.key, label: w.label)]).sorted { $0.n < $1.n }
    }
}
