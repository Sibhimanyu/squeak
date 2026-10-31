import AVFoundation
import Foundation
import Observation

/// Owns one settings sample. Cancelling invalidates late network replies before they can play.
@MainActor @Observable public final class VoicePreview: NSObject, AVAudioPlayerDelegate {
    public private(set) var loading = false
    public private(set) var playing = false
    public private(set) var error: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var generation = 0

    public var active: Bool { loading || playing }

    public func play(voice: String, engine: String? = nil, client: DaemonClient) {
        stop()
        loading = true
        let request = generation
        task = Task { [weak self] in
            do {
                let data = try await client.previewNaturalVoice(voice, engine: engine)
                guard let self, !Task.isCancelled, self.generation == request else { return }
                let player = try AVAudioPlayer(data: data)
                self.player = player
                player.delegate = self
                guard player.play() else { throw CocoaError(.fileReadCorruptFile) }
                self.loading = false
                self.playing = true
            } catch {
                guard let self, !Task.isCancelled, self.generation == request else { return }
                self.loading = false
                self.player = nil
                self.error = "Couldn’t play the sample. Check that Squeak is running and the voice is installed, then try again."
            }
        }
    }

    public func stop() {
        generation += 1
        task?.cancel()
        task = nil
        player?.stop()
        player = nil
        loading = false
        playing = false
        error = nil
    }

    nonisolated public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self, let current = self.player, ObjectIdentifier(current) == identity else { return }
            self.player = nil
            self.playing = false
            if !flag { self.error = "The sample couldn’t finish playing. Try again." }
        }
    }

    nonisolated public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self, let current = self.player, ObjectIdentifier(current) == identity else { return }
            self.stop()
            self.error = "The sample couldn’t be played. Try again."
        }
    }
}
