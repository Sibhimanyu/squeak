import AVFoundation
import AppKit
import Speech
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Voice dictation for a composer: microphone -> SFSpeechRecognizer, on the device when this Mac can. Nothing is
/// recorded to disk or sent anywhere by Squeak; the words come back as text for the person to review, never sent.
/// The phase logic is `DictationState` (SqueakMacCore); this is the AVAudioEngine and Speech glue.
@MainActor @Observable
final class DictationController {
    private(set) var state = DictationState()
    /// The newest levels (0...1), oldest first, for the meter.
    private(set) var levels: [Float] = Array(repeating: 0, count: DictationController.barCount)
    static let barCount = 28

    /// The dictated words, once recognition ends, to append to the draft.
    var onText: ((String) -> Void)?

    private var capture: Capture?
    private var generation = 0
    private var limitTask: Task<Void, Never>?
    private var closeObserver: NSObjectProtocol?

    /// Everything the audio thread and the recogniser touch, kept out of the main actor.
    private final class Capture: @unchecked Sendable {
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        var task: SFSpeechRecognitionTask?
        var recognizer: SFSpeechRecognizer?
        func tearDown() {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
    }

    isolated deinit { if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) } }

    var isActive: Bool { state.isActive }

    /// The mic button: start, or confirm while recording.
    func toggle() {
        switch state.phase {
        case .recording: stop()
        case .requesting, .finishing: break
        default: start()
        }
    }

    func start() {
        guard state.start() else { return }
        generation += 1
        let mine = generation
        Task { await begin(mine) }
    }

    /// ✓: stop listening; the last words arrive in a moment and are appended.
    func stop() {
        guard state.phase == .recording else { return }
        state.stop()
        capture?.tearDown()
        capture?.request.endAudio()
        limitTask?.cancel()
        let mine = generation
        // The recogniser normally ends on its own; if it does not, keep what was heard.
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if mine == generation, state.phase == .finishing { complete(finalText: nil) }
        }
    }

    /// ✕, chat switch, window close: nothing is kept.
    func cancel() {
        generation += 1
        limitTask?.cancel()
        capture?.task?.cancel()
        capture?.tearDown()
        capture = nil
        state.cancel()
        resetLevels()
        removeCloseObserver()
    }

    func dismiss() { state.dismiss() }

    func openSettings() {
        guard case .denied(let which) = state.phase, let url = URL(string: which.settingsURL) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: Start

    private func begin(_ mine: Int) async {
        guard await ensureMicrophone() else { return fail(mine, denied: .microphone) }
        guard mine == generation else { return }
        guard await ensureSpeech() else { return fail(mine, denied: .speechRecognition) }
        guard mine == generation, state.phase == .requesting else { return }

        let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer, recognizer.isAvailable else {
            state.fail("Speech recognition isn't available for this language right now.")
            return
        }
        let capture = Capture()
        capture.recognizer = recognizer
        capture.request.shouldReportPartialResults = true
        capture.request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition {
            capture.request.requiresOnDeviceRecognition = true
        } else {
            state.recognitionRunsOnServer()
        }

        let input = capture.engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            state.fail("No microphone is available.")
            return
        }
        let request = capture.request
        Self.installTap(on: input, format: format, request: request) { [weak self] level in
            Task { @MainActor in self?.pushLevel(level, generation: mine) }
        }
        do {
            capture.engine.prepare()
            try capture.engine.start()
        } catch {
            capture.tearDown()
            state.fail("Couldn't start the microphone.")
            return
        }
        capture.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in self?.heard(text, isFinal: isFinal, failed: failed, generation: mine) }
        }
        self.capture = capture
        state.permissionGranted()
        watchWindow()
        limitTask?.cancel()
        limitTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(DictationState.timeLimit))
            if !Task.isCancelled { self?.stop() }
        }
    }

    private func fail(_ mine: Int, denied: DictationPermission) {
        guard mine == generation else { return }
        state.permissionDenied(denied)
    }

    private func ensureMicrophone() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    private func ensureSpeech() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }

    /// Runs on the audio thread: feed the recogniser and report the level. Nothing is stored.
    nonisolated private static func installTap(
        on input: AVAudioInputNode, format: AVAudioFormat, request: SFSpeechAudioBufferRecognitionRequest,
        level: @escaping @Sendable (Float) -> Void
    ) {
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            request.append(buffer)
            guard let data = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            var sum: Float = 0
            for i in 0..<n { sum += data[i] * data[i] }
            let rms = (sum / Float(n)).squareRoot()
            level(DictationState.level(decibels: 20 * log10(max(rms, 0.000_001))))
        }
    }

    // MARK: Results

    private func heard(_ text: String?, isFinal: Bool, failed: Bool, generation g: Int) {
        guard g == generation else { return }
        if let text { state.gotPartial(text) }
        if isFinal { complete(finalText: text); return }
        if failed {
            // A cancelled or ended task errors after endAudio; keep what was heard.
            if state.phase == .finishing || !state.partial.isEmpty { complete(finalText: nil) }
            else if state.phase == .recording { teardown(); state.fail("Couldn't hear anything. Try again.") }
        }
    }

    private func complete(finalText: String?) {
        let words = state.finish(finalText: finalText)
        teardown()
        if let words { onText?(words) }
    }

    private func teardown() {
        generation += 1
        limitTask?.cancel()
        capture?.task?.cancel()
        capture?.tearDown()
        capture = nil
        resetLevels()
        removeCloseObserver()
    }

    // MARK: Level and window

    private func pushLevel(_ level: Float, generation g: Int) {
        guard g == generation, state.phase == .recording else { return }
        levels.removeFirst()
        levels.append(level)
    }

    private func resetLevels() { levels = Array(repeating: 0, count: Self.barCount) }

    /// Closing the window recording started in stops it, keeping nothing.
    private func watchWindow() {
        removeCloseObserver()
        guard let window = NSApp.keyWindow else { return }
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.cancel() }
        }
    }

    private func removeCloseObserver() {
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
    }
}

/// The meter that replaces the text area while recording: bars from the live level, the words heard so far,
/// and ✕ / ✓.
struct DictationBar: View {
    let dictation: DictationController

    var body: some View {
        HStack(spacing: Space.m) {
            Button { dictation.cancel() } label: {
                Lucide(.x, size: 16, color: Theme.muted).frame(width: 28, height: 28).contentShape(Circle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.escape, modifiers: [])
            .help("Cancel dictation (esc)")
            .accessibilityLabel("Cancel dictation")

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 2) {
                    ForEach(Array(dictation.levels.enumerated()), id: \.offset) { _, level in
                        Capsule().fill(Theme.muted).frame(width: 3, height: 3 + CGFloat(level) * 19)
                    }
                }
                .frame(height: 24, alignment: .center)
                .accessibilityHidden(true)
                Text(verbatim: dictation.state.partial.isEmpty ? "Listening…" : dictation.state.partial)
                    .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Listening")

            Button { dictation.stop() } label: {
                Lucide(.check, size: 16, color: Theme.primaryText)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Theme.primaryFill))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(dictation.state.phase != .recording)
            .help("Finish dictation. Nothing is sent.")
            .accessibilityLabel("Finish dictation")
        }
        .padding(.horizontal, 4)
        .frame(minHeight: 36)
    }
}

/// An inline message under the composer's text: why dictation can't run, with the right Settings pane.
struct DictationNotice: View {
    let dictation: DictationController

    var body: some View {
        if let note = dictation.state.notice {
            HStack(spacing: Space.s) {
                Text(verbatim: note).font(Typo.meta)
                    .foregroundStyle(dictation.state.phase.isTrouble ? Theme.negative : Theme.muted)
                if case .denied = dictation.state.phase {
                    Button("Open System Settings") { dictation.openSettings() }
                        .buttonStyle(.plain).font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.ink)
                }
                if dictation.state.phase.isTrouble {
                    Button { dictation.dismiss() } label: { Lucide(.x, size: 12, color: Theme.muted) }
                        .buttonStyle(.plain).accessibilityLabel("Dismiss")
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
        }
    }
}

private extension DictationPhase {
    var isTrouble: Bool {
        switch self {
        case .denied, .failed: true
        default: false
        }
    }
}
