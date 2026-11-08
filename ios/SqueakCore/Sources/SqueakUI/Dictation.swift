#if os(iOS)
import AVFoundation
import Observation
import Speech
import UIKit

/// Voice dictation for the composer: on-device Speech, partial words streamed into the field, nothing sent.
///
/// The words are recognised on the phone (`requiresOnDeviceRecognition`) whenever the recogniser supports it;
/// only where it does not, Apple's servers are used and `note` says so. No audio is saved: buffers go straight
/// to the recogniser and are dropped. The audio session is released after every recording. The state logic is
/// `Dictation` (ComposerSupport.swift), which `swift test` covers.
@MainActor
@Observable
final class DictationController {
    private(set) var machine = Dictation()
    private(set) var window = LevelWindow()
    /// One line about how it is running ("transcribed by Apple's servers") or why it failed.
    private(set) var note: String?

    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var limit: Task<Void, Never>?
    private var finishTimeout: Task<Void, Never>?
    /// A cancel or stop that arrives while permissions are still being asked.
    private var generation = 0

    var state: DictationState { machine.state }
    var isActive: Bool { machine.isActive }
    var liveText: String { machine.liveText }
    var base: String { machine.base }

    /// Begins listening; `base` is what the field holds now.
    func start(base: String) {
        guard !machine.isActive else { return }
        machine.start(base: base)
        note = nil
        window.clear()
        generation += 1
        let mine = generation
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { await begin(mine) }
    }

    /// The check: keep what was heard once the recogniser has said its last word.
    func stop() {
        guard machine.state == .recording else { if machine.state == .requesting { cancel() }; return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        apply(.stop)
        endAudio()
        finishTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.apply(.finished)
        }
    }

    /// The cross: drop what was heard.
    func cancel() {
        guard machine.isActive else { return }
        apply(.cancel)
    }

    /// Leaving the chat or the app: stop now and keep what was heard; returns the field's text.
    @discardableResult
    func stopNow() -> String? {
        guard machine.isActive else { return nil }
        if machine.state == .requesting { apply(.cancel); return nil }
        apply(.stop)
        apply(.finished)
        return machine.liveText
    }

    func clearProblem() {
        if case .idle = machine.state { return }
        if !machine.isActive { machine = Dictation(); note = nil }
    }

    // MARK: running

    private func begin(_ mine: Int) async {
        let speech = await Self.speechAllowed()
        guard mine == generation, machine.state == .requesting else { return }
        guard speech else { apply(.denied(.speech)); return }
        let mic = await Self.microphoneAllowed()
        guard mine == generation, machine.state == .requesting else { return }
        guard mic else { apply(.denied(.microphone)); return }
        guard let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
            apply(.denied(.unavailable)); return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        } else {
            note = "On-device recognition isn't available here, so Apple's servers transcribe this."
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: [])
            let engine = AVAudioEngine()
            let levels = Self.install(tap: engine.inputNode, request: request) { [weak self] rms in
                Task { @MainActor in self?.window.push(rms: rms) }
            }
            guard levels else { throw DictationFailure.noInput }
            engine.prepare()
            try engine.start()
            self.engine = engine
            self.request = request
            task = recognizer.recognitionTask(with: request, resultHandler: Self.handler(for: self))
        } catch {
            teardown()
            apply(.failed("Couldn't start the microphone."))
            note = "Couldn't start the microphone."
            return
        }
        apply(.granted)
        limit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Dictation.timeLimit))
            guard !Task.isCancelled else { return }
            self?.stop()
        }
    }

    private enum DictationFailure: Error { case noInput }

    /// Built outside the main actor's isolation: Speech calls it on its own queue.
    private nonisolated static func handler(for controller: DictationController) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak controller] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in controller?.recognised(text: text, isFinal: isFinal, failed: failed) }
        }
    }

    private func recognised(text: String?, isFinal: Bool, failed: Bool) {
        guard machine.isActive else { return }
        if isFinal { apply(.final(text ?? "")); return }
        if let text, !text.isEmpty { apply(.partial(text)) }
        if failed {
            // After a stop, an error is the recogniser closing (no speech, cancelled): keep what was heard.
            if machine.state == .finishing { apply(.finished) } else { apply(.failed("Couldn't hear that. Try again.")); note = "Couldn't hear that. Try again." }
        }
    }

    private func apply(_ event: DictationEvent) {
        machine.handle(event)
        if !machine.isActive { teardown() }
    }

    private func endAudio() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        request?.endAudio()
    }

    /// Stops everything and gives the audio session back; no audio was kept.
    private func teardown() {
        generation += 1
        limit?.cancel(); finishTimeout?.cancel()
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        window.clear()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: permissions

    private static func speechAllowed() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
        }
    }

    private static func microphoneAllowed() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Feeds the recogniser from the microphone and reports each buffer's level. False without an input.
    private nonisolated static func install(tap input: AVAudioInputNode, request: SFSpeechAudioBufferRecognitionRequest,
                                            level: @escaping @Sendable (Float) -> Void) -> Bool {
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            guard let data = buffer.floatChannelData?[0] else { return }
            let count = Int(buffer.frameLength)
            guard count > 0 else { return }
            var sum: Float = 0
            for i in 0..<count { sum += data[i] * data[i] }
            level((sum / Float(count)).squareRoot())
        }
        return true
    }

    static func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
}
#endif
