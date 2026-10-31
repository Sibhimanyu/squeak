import Foundation

// The Mac app's Voice settings on the phone: the realistic voice, Quick workspaces and the call history. Wire
// shapes: .context/voice-parity-protocol.md, docs/remote-channel.md "Voice parity with the Mac app". Every field is
// optional, so a phone updated before its Mac keeps decoding, and every decoder is tolerant: an unknown word never
// fails the view.

/// The realistic voice (Kokoro) on the Mac. `voices` is absent from a Mac that predates the picker: the controls
/// are then hidden, because that Mac would refuse the commands.
public struct NaturalVoiceView: Codable, Equatable, Sendable {
    public var installed: Bool
    public var enabled: Bool
    public var voice: String
    public var voices: [VoiceChoice]?
    /// True when this Mac can make a voice sample and leave it in the channel (Realtime Database, a preview here).
    /// Absent from an older Mac: the Play sample button is then hidden.
    public var sample: Bool?
    /// The engine speaking calls now (`kokoro`, `qwen3`, `ming`, `chatterbox`), `off`/`subtle`/`strong`, and every
    /// engine this Mac knows. All absent from a Mac that predates engines: the phone then shows today's Kokoro-only
    /// controls.
    public var engine: String?
    public var emotion: String?
    public var engines: [EngineChoice]?

    public struct EngineChoice: Codable, Equatable, Sendable, Identifiable, Hashable {
        public var id: String
        public var label: String
        public var summary: String
        public var size: String
        public var installed: Bool
        public var emotion: Bool
        public var voices: [VoiceChoice]
        public var voice: String
        public var licence: String

        public init(id: String, label: String, summary: String = "", size: String = "", installed: Bool, emotion: Bool = false,
                    voices: [VoiceChoice] = [], voice: String = "", licence: String = "") {
            self.id = id; self.label = label; self.summary = summary; self.size = size; self.installed = installed
            self.emotion = emotion; self.voices = voices; self.voice = voice; self.licence = licence
        }

        enum CodingKeys: String, CodingKey { case id, label, summary, size, installed, emotion, voices, voice, licence }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decode(String.self, forKey: .id)) ?? ""
            label = (try? c.decode(String.self, forKey: .label)) ?? id
            summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
            size = (try? c.decode(String.self, forKey: .size)) ?? ""
            installed = (try? c.decode(Bool.self, forKey: .installed)) ?? false
            emotion = (try? c.decode(Bool.self, forKey: .emotion)) ?? false
            voices = (try? c.decode([VoiceChoice].self, forKey: .voices)) ?? []
            voice = (try? c.decode(String.self, forKey: .voice)) ?? ""
            licence = (try? c.decode(String.self, forKey: .licence)) ?? ""
        }
    }

    public struct VoiceChoice: Codable, Equatable, Sendable, Identifiable, Hashable {
        public var id: String
        public var label: String
        public init(id: String, label: String) { self.id = id; self.label = label }
    }

    public init(installed: Bool, enabled: Bool, voice: String, voices: [VoiceChoice]? = nil, sample: Bool? = nil,
                engine: String? = nil, emotion: String? = nil, engines: [EngineChoice]? = nil) {
        self.installed = installed; self.enabled = enabled; self.voice = voice; self.voices = voices; self.sample = sample
        self.engine = engine; self.emotion = emotion; self.engines = engines
    }

    enum CodingKeys: String, CodingKey { case installed, enabled, voice, voices, sample, engine, emotion, engines }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = (try? c.decode(Bool.self, forKey: .installed)) ?? false
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        voice = (try? c.decode(String.self, forKey: .voice)) ?? ""
        voices = try? c.decode([VoiceChoice].self, forKey: .voices)
        sample = try? c.decode(Bool.self, forKey: .sample)
        engine = try? c.decode(String.self, forKey: .engine)
        emotion = try? c.decode(String.self, forKey: .emotion)
        engines = try? c.decode([EngineChoice].self, forKey: .engines)
    }

    /// The controls show only for a Mac that sends its voice list.
    public var offered: Bool { voices?.isEmpty == false }

    /// True when this Mac sends engines, so the engine and emotion pickers show.
    public var hasEngines: Bool { engines?.isEmpty == false }

    /// The engine speaking now; nil for a Mac without engines.
    public var currentEngine: EngineChoice? {
        guard let engines, !engines.isEmpty else { return nil }
        return engines.first { $0.id == engine } ?? engines.first { $0.id == "kokoro" }
    }

    /// Only installed engines can be picked; a phone cannot start a multi-GB install.
    public var pickableEngines: [EngineChoice] { (engines ?? []).filter(\.installed) }
    public var greyedEngines: [EngineChoice] { (engines ?? []).filter { !$0.installed } }

    /// The voices of the engine speaking now (the top-level list for a Mac without engines).
    public var currentVoices: [VoiceChoice] { currentEngine?.voices ?? voices ?? [] }

    /// Emotion shows only for an engine that has it; Kokoro and an older Mac have none.
    public var showsEmotion: Bool { currentEngine?.emotion == true }

    /// `off`, `subtle` or `strong`; anything else (or absent) reads as the default, subtle.
    public var emotionLevel: String { EmotionLevel.all.contains(emotion ?? "") ? emotion! : EmotionLevel.subtle }

    /// The voice to send a sample request for, and the engine to name in it (nil for a Mac without engines, so the
    /// request is today's bytes).
    public var sampleEngine: String? { hasEngines ? currentEngine?.id : nil }
}

public enum EmotionLevel {
    public static let off = "off", subtle = "subtle", strong = "strong"
    public static let all = [off, subtle, strong]
    public static func label(_ level: String) -> String {
        switch level { case off: return "Off"; case strong: return "Strong"; default: return "Subtle" }
    }
}

/// A workspace a call can pick with one key: `n` is the keypad digit 1 to 9.
public struct FavoriteWorkspace: Codable, Equatable, Sendable, Identifiable {
    public var n: Int
    public var workspace: String
    public var label: String
    public var id: Int { n }

    public init(n: Int, workspace: String, label: String = "") { self.n = n; self.workspace = workspace; self.label = label }

    enum CodingKeys: String, CodingKey { case n, workspace, label }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        n = (try? c.decode(Int.self, forKey: .n)) ?? 0
        workspace = (try? c.decode(String.self, forKey: .workspace)) ?? ""
        label = (try? c.decode(String.self, forKey: .label)) ?? workspace
    }
}

/// A workspace a favourite may name (`workspaces` in the voice view).
public struct WorkspaceChoice: Codable, Equatable, Sendable, Identifiable, Hashable {
    public var key: String
    public var label: String
    public var id: String { key }

    public init(key: String, label: String) { self.key = key; self.label = label }

    enum CodingKeys: String, CodingKey { case key, label }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? c.decode(String.self, forKey: .key)) ?? ""
        label = (try? c.decode(String.self, forKey: .label)) ?? key
    }
}

/// The list rules for Quick workspaces, the same as the Mac app's, plus the Mac daemon's own checks so the phone
/// never sends a list it would refuse.
public enum QuickWorkspaces {
    public static let numbers = Array(1...9)
    public static let maxWorkspaceLength = 200

    /// Numbers a row may take: its own plus every number no other row holds.
    public static func availableNumbers(for row: Int, in list: [FavoriteWorkspace]) -> [Int] {
        let others = Set(list.filter { $0.n != row }.map(\.n))
        return numbers.filter { $0 == row || !others.contains($0) }
    }

    public static func nextFreeNumber(in list: [FavoriteWorkspace]) -> Int? {
        let used = Set(list.map(\.n))
        return numbers.first { !used.contains($0) }
    }

    /// Moves a row to another number; nil when another row holds it or it is outside 1 to 9.
    public static func renumbered(_ list: [FavoriteWorkspace], from n: Int, to new: Int) -> [FavoriteWorkspace]? {
        guard numbers.contains(new), n == new || !list.contains(where: { $0.n == new }) else { return nil }
        return list.map { $0.n == n ? FavoriteWorkspace(n: new, workspace: $0.workspace, label: $0.label) : $0 }.sorted { $0.n < $1.n }
    }

    /// Points a row at another workspace.
    public static func replaced(_ list: [FavoriteWorkspace], n: Int, with choice: WorkspaceChoice) -> [FavoriteWorkspace] {
        list.map { $0.n == n ? FavoriteWorkspace(n: n, workspace: choice.key, label: choice.label) : $0 }
    }

    public static func removed(_ list: [FavoriteWorkspace], n: Int) -> [FavoriteWorkspace] { list.filter { $0.n != n } }

    /// Adds the first candidate not already used at the lowest free number; nil when none is left or 9 are used.
    public static func added(_ list: [FavoriteWorkspace], candidates: [WorkspaceChoice]) -> [FavoriteWorkspace]? {
        guard let n = nextFreeNumber(in: list),
              let w = candidates.first(where: { c in !list.contains { $0.workspace == c.key } }) else { return nil }
        return (list + [FavoriteWorkspace(n: n, workspace: w.key, label: w.label)]).sorted { $0.n < $1.n }
    }

    /// Whether the Mac would take this list: at most 9, digits 1 to 9 once each, a workspace of 1 to 200
    /// characters that the Mac offers (or already saved).
    public static func isValid(_ list: [FavoriteWorkspace], offered: [WorkspaceChoice], saved: [FavoriteWorkspace]) -> Bool {
        guard list.count <= 9, Set(list.map(\.n)).count == list.count else { return false }
        let known = Set(offered.map(\.key)).union(saved.map(\.workspace))
        return list.allSatisfy {
            numbers.contains($0.n) && !$0.workspace.isEmpty && $0.workspace.count <= maxWorkspaceLength && known.contains($0.workspace)
        }
    }
}

// MARK: Calls

public enum CallKind: String, Sendable, Equatable { case agent, test, incoming }
public enum CallEventKind: String, Sendable, Equatable { case step, said, heard, key, warn }
public enum CallEventSource: String, Sendable, Equatable { case mac, addOn = "add-on" }
public enum CallOutcome: String, Sendable, Equatable {
    case answered, unanswered, failed
    case movedOn = "moved_on"
}

/// One line of a call's timeline (oldest first).
public struct CallEvent: Codable, Sendable, Equatable, Identifiable {
    public var at: Double
    public var source: CallEventSource
    public var kind: CallEventKind
    public var text: String
    public var id: String { "\(at)-\(kind.rawValue)-\(text)" }

    public init(at: Double, source: CallEventSource = .mac, kind: CallEventKind = .step, text: String) {
        self.at = at; self.source = source; self.kind = kind; self.text = text
    }

    enum CodingKeys: String, CodingKey { case at, source, kind, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
        source = (try? c.decode(String.self, forKey: .source)).flatMap(CallEventSource.init(rawValue:)) ?? .mac
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(CallEventKind.init(rawValue:)) ?? .step
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at)
        try c.encode(source.rawValue, forKey: .source)
        try c.encode(kind.rawValue, forKey: .kind)
        try c.encode(text, forKey: .text)
    }
}

/// One call in the history (`voice.calls`, newest first).
public struct CallEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var at: Double
    public var kind: CallKind
    public var reason: String?
    public var label: String?
    public var outcome: CallOutcome
    public var letter: String?
    public var sent: Bool?
    public var durationMs: Double
    public var failure: String?
    public var events: [CallEvent]

    public init(id: String, at: Double, kind: CallKind = .agent, reason: String? = nil, label: String? = nil,
                outcome: CallOutcome = .unanswered, letter: String? = nil, sent: Bool? = nil, durationMs: Double = 0,
                failure: String? = nil, events: [CallEvent] = []) {
        self.id = id; self.at = at; self.kind = kind; self.reason = reason; self.label = label; self.outcome = outcome
        self.letter = letter; self.sent = sent; self.durationMs = durationMs; self.failure = failure; self.events = events
    }

    enum CodingKeys: String, CodingKey { case id, at, kind, reason, label, outcome, letter, sent, durationMs, failure, events }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
        id = (try? c.decode(String.self, forKey: .id)) ?? "call-\(Int(at))"
        // Unknown words read as the safest: an agent call nobody answered.
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(CallKind.init(rawValue:)) ?? .agent
        outcome = (try? c.decode(String.self, forKey: .outcome)).flatMap(CallOutcome.init(rawValue:)) ?? .unanswered
        reason = try? c.decode(String.self, forKey: .reason)
        label = try? c.decode(String.self, forKey: .label)
        letter = try? c.decode(String.self, forKey: .letter)
        sent = try? c.decode(Bool.self, forKey: .sent)
        durationMs = (try? c.decode(Double.self, forKey: .durationMs)) ?? 0
        failure = try? c.decode(String.self, forKey: .failure)
        events = (try? c.decode([CallEvent].self, forKey: .events)) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(at, forKey: .at)
        try c.encode(kind.rawValue, forKey: .kind)
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encodeIfPresent(label, forKey: .label)
        try c.encode(outcome.rawValue, forKey: .outcome)
        try c.encodeIfPresent(letter, forKey: .letter)
        try c.encodeIfPresent(sent, forKey: .sent)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encodeIfPresent(failure, forKey: .failure)
        try c.encode(events, forKey: .events)
    }
}

/// Plain-words formatting and the plain-text exports used by Copy; the same words as the Mac app.
public enum CallText {
    public static let unavailable = "Update Squeak on your Mac to see calls here."
    public static let empty = "No calls yet. When an agent is waiting on you, or you place a test call, it shows here."
    public static let loading = "Loading\u{2026}"

    public static func what(_ e: CallEntry) -> String {
        if e.kind == .test { return "Test call" }
        if e.kind == .incoming {
            if let l = e.label, !l.isEmpty { return "You called Squeak \u{00B7} \(l)" }
            return "You called Squeak"
        }
        if let l = e.label, !l.isEmpty { return l }
        switch e.reason {
        case "blocked_approval": return "An approval was waiting"
        case "blocked_question", "asked_question": return "A question was waiting"
        default: return "An agent call"
        }
    }

    public static func outcomeSentence(_ e: CallEntry) -> String {
        switch e.outcome {
        case .answered where e.kind == .incoming:
            return e.sent == true ? "Message taken \u{00B7} sent to the chat" : "Message taken"
        case .answered:
            var s = "Answered"
            if let l = e.letter, !l.isEmpty { s += ", pressed \(l)" }
            if e.sent == true { s += " \u{00B7} sent" } else if e.sent == false, e.letter != nil { s += " \u{00B7} not sent" }
            return s
        case .unanswered: return "Not answered"
        case .failed:
            if let f = e.failure, !f.isEmpty { return "Could not be placed: \(f)" }
            return "Could not be placed"
        case .movedOn: return "Answered, but the chat had moved on"
        }
    }

    /// "42 s", "1 min 12 s", "3 min"; under a second reads "0 s".
    public static func duration(ms: Double) -> String {
        let total = max(0, Int((ms / 1000).rounded()))
        if total < 60 { return "\(total) s" }
        let m = total / 60, s = total % 60
        return s == 0 ? "\(m) min" : "\(m) min \(s) s"
    }

    private static func formatter(_ calendar: Calendar, _ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.calendar = calendar; f.timeZone = calendar.timeZone; f.locale = Locale(identifier: "en_GB")
        f.dateFormat = format
        return f
    }

    /// "Today 14:02", "Yesterday 09:15", "Mon 3 Nov 14:02" (older).
    public static func when(ms: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let time = formatter(calendar, "HH:mm").string(from: d)
        if calendar.isDate(d, inSameDayAs: now) { return "Today \(time)" }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(d, inSameDayAs: y) { return "Yesterday \(time)" }
        return formatter(calendar, "EEE d MMM HH:mm").string(from: d)
    }

    public static func callRow(_ e: CallEntry, now: Date = Date(), calendar: Calendar = .current) -> String {
        "\(when(ms: e.at, now: now, calendar: calendar)) \u{00B7} \(what(e)) \u{00B7} \(outcomeSentence(e)) \u{00B7} \(duration(ms: e.durationMs))"
    }

    public static func callsExport(_ calls: [CallEntry], now: Date = Date(), calendar: Calendar = .current) -> String {
        calls.map { callRow($0, now: now, calendar: calendar) }.joined(separator: "\n")
    }

    public static func eventTime(_ ms: Double, calendar: Calendar = .current) -> String {
        formatter(calendar, "HH:mm:ss.SSS").string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    public static func sourceTag(_ s: CallEventSource) -> String { s == .mac ? "Mac" : "Add-on" }

    public static func kindLabel(_ k: CallEventKind) -> String {
        switch k {
        case .step: "Step"
        case .said: "Squeak said"
        case .heard: "Heard"
        case .key: "Key"
        case .warn: "Warning"
        }
    }

    /// The text of one timeline line: said and heard are quoted.
    public static func eventBody(_ e: CallEvent) -> String {
        switch e.kind {
        case .said, .heard: "\u{201C}\(e.text)\u{201D}"
        default: e.text
        }
    }

    public static func eventLine(_ e: CallEvent, calendar: Calendar = .current) -> String {
        "\(eventTime(e.at, calendar: calendar)) [\(sourceTag(e.source))] \(kindLabel(e.kind)): \(eventBody(e))"
    }

    /// Direction, who, total time, outcome.
    public static func summary(_ e: CallEntry) -> String {
        var parts = [e.kind == .incoming ? "Incoming" : "Outgoing", what(e), duration(ms: e.durationMs), outcomeSentence(e)]
        if e.kind == .incoming { parts.remove(at: 1) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The whole timeline as plain text, one line per event.
    public static func timelineExport(_ e: CallEntry, calendar: Calendar = .current) -> String {
        ([summary(e)] + e.events.map { eventLine($0, calendar: calendar) }).joined(separator: "\n")
    }

    /// Every call with its timeline, for the sheet's Copy.
    public static func fullExport(_ calls: [CallEntry], calendar: Calendar = .current) -> String {
        calls.map { "\(when(ms: $0.at, calendar: calendar))\n\(timelineExport($0, calendar: calendar))" }.joined(separator: "\n\n")
    }
}

/// The words of the new Phone calls sections.
public enum VoiceParityText {
    public static let naturalTitle = "Speak with this Mac's voice"
    public static let naturalDetail = "A realistic voice made on this Mac, played in the call."
    public static let notInstalled = "Not installed. Run this in Terminal once (about 350 MB); calls use it afterwards."
    public static let installCommand = "squeak voice-tts-setup"
    public static let voiceFooter = "The words never leave your Mac. If speech fails during a call, the plain voice speaks and the call still goes."
    public static let quickFooter = "On a call, Squeak reads these first. Press the number to pick the workspace, then the chat."
    public static let noWorkspaces = "No workspaces yet \u{2014} open a chat in Conductor."
    public static let engineTitle = "Engine"
    public static let engineGreyed = "Set up on your Mac"
    public static let emotionTitle = "Emotion"
    public static let emotionFooter = "How much feeling the voice puts into each line, chosen from the words."
    public static let samplePlay = "Play sample"
    public static let sampleStop = "Stop sample"
    public static let sampleMaking = "Making sample\u{2026}"
    public static let samplePlaying = "Playing on this phone"
    public static let sampleFailed = "Couldn\u{2019}t play the sample. Check that Squeak is running and the voice is installed, then try again."
    public static let sampleBroke = "The sample couldn\u{2019}t finish playing. Try again."
    public static let historyFooter = "Every call Squeak made, and what happened."
}
