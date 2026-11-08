import Foundation

/// The state of one dictation, kept free of Speech and AVFoundation so `swift test` covers every transition.
///
/// idle -> requesting (permissions) -> recording -> finishing (the recogniser's last word) -> idle.
/// Nothing here sends anything: the text only flows into the composer's field, and the person presses Send.
public enum DictationState: Equatable, Sendable {
    case idle
    case requesting
    case recording
    case finishing
    case denied(DictationDenial)
    case failed(String)
}

public enum DictationDenial: Equatable, Sendable {
    case microphone
    case speech
    /// Speech recognition is not available for this language or on this device right now.
    case unavailable
}

public enum DictationEvent: Equatable, Sendable {
    case granted
    case denied(DictationDenial)
    /// The words so far; they replace the earlier partial.
    case partial(String)
    /// The recogniser's last word; ends the dictation.
    case final(String)
    /// The check (or the app / chat going away, or the two-minute limit): stop listening, keep what was heard.
    case stop
    case cancel
    case failed(String)
    /// The recogniser finished (or gave up waiting) after a stop.
    case finished
}

public struct Dictation: Equatable, Sendable {
    /// The longest one recording runs.
    public static let timeLimit: TimeInterval = 120

    public private(set) var state: DictationState = .idle
    /// What was in the field when the recording began; a cancel puts it back.
    public private(set) var base = ""
    public private(set) var transcript = ""

    public init() {}

    public var isActive: Bool {
        switch state {
        case .requesting, .recording, .finishing: return true
        default: return false
        }
    }

    /// What the field shows now: the earlier draft with the heard words after it.
    public var liveText: String { Dictation.merge(base: base, heard: transcript) }

    /// Begins from idle, denied or failed (a retry); ignored while one is already running.
    public mutating func start(base: String) {
        switch state {
        case .idle, .denied, .failed:
            self.base = base
            transcript = ""
            state = .requesting
        default: break
        }
    }

    public mutating func handle(_ event: DictationEvent) {
        switch (state, event) {
        case (.requesting, .granted): state = .recording
        case (.requesting, .denied(let why)): reset(.denied(why))
        case (.requesting, .stop), (.requesting, .cancel): reset(.idle)
        case (.requesting, .failed(let why)): reset(.failed(why))

        case (.recording, .partial(let text)), (.finishing, .partial(let text)): transcript = text
        case (.recording, .final(let text)), (.finishing, .final(let text)):
            if !text.isEmpty { transcript = text }
            state = .idle
        case (.recording, .stop): state = .finishing
        case (.finishing, .stop): break
        case (.finishing, .finished): state = .idle
        case (.recording, .finished): state = .idle
        case (.recording, .cancel), (.finishing, .cancel):
            transcript = ""
            state = .idle
        case (.recording, .failed(let why)), (.finishing, .failed(let why)):
            // Words already heard are kept: an error at the end must not throw them away.
            if transcript.isEmpty { state = .failed(why) } else { state = .idle }
        default: break
        }
    }

    private mutating func reset(_ next: DictationState) {
        transcript = ""
        state = next
    }

    /// The draft with the heard words after it: one space between, or none if the draft already ends in
    /// whitespace; the words alone into an empty draft.
    public static func merge(base: String, heard: String) -> String {
        let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty { return base }
        if base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return words }
        if let last = base.last, last.isWhitespace { return base + words }
        return base + " " + words
    }
}

/// The composer's model label: the model in the main weight, the thinking level and the rest lighter.
public enum ComposerSetupLabel {
    private static let levels: Set<String> = ["none", "minimal", "low", "medium", "high", "extra high", "xhigh", "max"]

    /// "Opus 5.5 · 1M · Medium · Fast" -> ("Opus 5.5 · 1M", "Medium · Fast"). No level in the line: all model.
    public static func split(_ line: String) -> (model: String, detail: String) {
        let parts = line.components(separatedBy: " · ")
        guard let at = parts.firstIndex(where: { levels.contains($0.lowercased()) }), at > 0 else { return (line, "") }
        return (parts[..<at].joined(separator: " · "), parts[at...].joined(separator: " · "))
    }
}

/// A rolling window of microphone levels for the waveform, newest last, each 0...1.
public struct LevelWindow: Equatable, Sendable {
    public private(set) var levels: [Float]
    public let capacity: Int

    public init(capacity: Int = 36) {
        self.capacity = capacity
        levels = Array(repeating: 0, count: capacity)
    }

    public mutating func push(rms: Float) {
        // About -50 dB (silence) to -10 dB (speech close to the mic), on a 0...1 scale.
        let db = 20 * log10(max(rms, 0.000_001))
        let level = min(1, max(0, (db + 50) / 40))
        levels.append(level)
        if levels.count > capacity { levels.removeFirst(levels.count - capacity) }
    }

    public mutating func clear() { levels = Array(repeating: 0, count: capacity) }
}
