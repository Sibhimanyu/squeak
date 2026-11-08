import Foundation

/// Voice dictation's state machine: what the composer shows and which events are allowed. The audio engine and
/// the speech recogniser live in the app target; this decides only the phase, so CI can test it.
public enum DictationPhase: Equatable, Sendable {
    case idle
    /// Waiting for the microphone and speech-recognition prompts.
    case requesting
    case recording
    /// Stopped by the person (or the time limit); the recogniser is delivering its last words.
    case finishing
    /// A permission was refused. `settingsPane` says which System Settings pane to open.
    case denied(DictationPermission)
    case failed(String)
}

public enum DictationPermission: Equatable, Sendable {
    case microphone, speechRecognition

    public var settingsURL: String {
        switch self {
        case .microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case .speechRecognition: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
        }
    }

    public var message: String {
        switch self {
        case .microphone: "Squeak needs the microphone to hear you. Nothing is recorded or sent."
        case .speechRecognition: "Squeak needs Speech Recognition to turn your voice into text."
        }
    }
}

public struct DictationState: Equatable, Sendable {
    /// Recording stops by itself after this long.
    public static let timeLimit: TimeInterval = 120
    public static let serverNote = "This Mac can't transcribe on the device, so Apple's servers hear this."

    public private(set) var phase: DictationPhase = .idle
    /// Words recognised so far in this recording; replaced by each partial result.
    public private(set) var partial = ""
    /// True when recognition has to leave the device (a one-line note is shown).
    public private(set) var usesServer = false

    public init() {}

    public var isActive: Bool {
        switch phase {
        case .requesting, .recording, .finishing: true
        default: false
        }
    }

    /// The text area is replaced by the level meter.
    public var showsMeter: Bool { phase == .recording || phase == .finishing }

    public var notice: String? {
        switch phase {
        case .denied(let p): p.message
        case .failed(let why): why
        case .recording, .finishing: usesServer ? Self.serverNote : nil
        default: nil
        }
    }

    /// The mic was pressed: only an idle (or finished-with-trouble) composer starts.
    @discardableResult
    public mutating func start() -> Bool {
        switch phase {
        case .idle, .denied, .failed:
            phase = .requesting; partial = ""; usesServer = false
            return true
        default: return false
        }
    }

    public mutating func permissionGranted() {
        if phase == .requesting { phase = .recording }
    }

    public mutating func permissionDenied(_ which: DictationPermission) {
        if phase == .requesting { phase = .denied(which) }
    }

    public mutating func recognitionRunsOnServer() { usesServer = true }

    public mutating func gotPartial(_ text: String) {
        if phase == .recording || phase == .finishing { partial = text }
    }

    /// ✓ or the time limit: stop listening and wait for the last result.
    public mutating func stop() {
        if phase == .recording { phase = .finishing }
        else if phase == .requesting { reset() }
    }

    /// The text to append to the draft once recognition ends; the state returns to idle.
    public mutating func finish(finalText: String?) -> String? {
        guard phase == .finishing || phase == .recording else { return nil }
        let text = (finalText ?? partial).trimmingCharacters(in: .whitespacesAndNewlines)
        reset()
        return text.isEmpty ? nil : text
    }

    /// ✕, a window close or a chat switch: nothing is kept.
    public mutating func cancel() { reset() }

    public mutating func fail(_ why: String) {
        guard isActive else { return }
        phase = .failed(why); partial = ""
    }

    /// Dismisses a denied or failed message.
    public mutating func dismiss() {
        switch phase {
        case .denied, .failed: reset()
        default: break
        }
    }

    private mutating func reset() { phase = .idle; partial = ""; usesServer = false }

    /// The draft with dictated words appended on their own space.
    public static func append(_ words: String, to draft: String) -> String {
        guard !words.isEmpty else { return draft }
        if draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") { return draft + words }
        return draft + " " + words
    }

    /// 0...1 from a mic's average power in decibels, for the level meter.
    public static func level(decibels: Float) -> Float {
        guard decibels.isFinite else { return 0 }
        let clamped = max(-60, min(0, decibels))
        return (clamped + 60) / 60
    }
}
