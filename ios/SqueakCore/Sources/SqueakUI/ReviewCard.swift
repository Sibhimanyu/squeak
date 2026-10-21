#if os(iOS)
import AVFoundation
import SqueakCore
import SqueakIcons
import SwiftUI

/// RasanAI's animatic or film, to watch and leave notes on, like the Director's Console: play it,
/// pause on a moment, tap the frame to pin a spot, write a note or tap a quick one. Notes go to the
/// director as you leave them; "Apply" sends the open ones back for a revision, and the last
/// button closes the call. The film comes over only when you ask: it is megabytes.
/// Everything here is the director's text: plain text only.
struct ReviewCard: View {
    let review: Workflow.Review
    let session: PhoneSnapshot.Session
    @Environment(AppModel.self) private var model
    @State private var player = ReviewPlayer()
    @State private var loading = false
    @State private var loadProblem: String?
    @State private var composing = false
    @State private var pin: CGPoint?
    @State private var quick: String?
    @State private var words = ""
    @State private var sending = false
    @State private var line: (delivered: Bool, text: String)?
    @State private var closed = false

    private var openNotes: [Workflow.Review.Note] { review.notes.filter { $0.state == "open" } }
    private var scene: Workflow.Review.Scene? { review.scene(at: player.time) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            surface
            transport
            if !review.scenes.isEmpty { sceneStrip }
            if composing { composer } else if !closed { noteButton }
            if !review.notes.isEmpty { notesList }
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onDisappear { player.pause() }
    }

    /* ---------- what plays ---------- */

    /// The film, or the animatic's still for this moment; a tap while writing a note pins a spot.
    private var surface: some View {
        ReviewSurface(
            player: player.isVideo ? player.avPlayer : nil,
            still: player.isVideo ? nil : stillImage,
            pin: pin,
            pinning: composing
        ) { point in
            pin = point
            UISelectionFeedbackGenerator().selectionChanged()
        }
        .frame(maxWidth: .infinity)
        .frame(height: 380)
        .background(Color.black, in: RoundedRectangle(cornerRadius: 12))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .center) {
            if review.media != nil, !player.ready {
                loadButton
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(review.kind == "animatic" ? "The animatic" : "The film")
    }

    @State private var stills: [String: UIImage] = [:]
    private var stillImage: UIImage? { scene?.thumb.flatMap { stills[$0] } }

    private var loadButton: some View {
        Button {
            guard let media = review.media else { return }
            loading = true
            loadProblem = nil
            Task {
                switch await model.loadMedia(session, source: media.source) {
                case let .file(url): player.load(url, video: media.kind == "video")
                case let .refused(reason): loadProblem = reason
                }
                loading = false
            }
        } label: {
            VStack(spacing: 8) {
                if loading {
                    ProgressView().tint(.white)
                    Text("Bringing it over from your Mac…").font(.footnote)
                } else {
                    Lucide(.play, size: 28, color: .white).accessibilityHidden(true)
                    Text(review.media?.kind == "video" ? "Watch the film" : "Play the animatic").font(.subheadline.weight(.semibold))
                    Text(loadProblem ?? "Comes over from your Mac when you tap").font(.caption).multilineTextAlignment(.center)
                }
            }
            .foregroundStyle(.white)
            .padding(16)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(loading)
    }

    private var transport: some View {
        HStack(spacing: 12) {
            Button { player.toggle() } label: {
                Lucide(player.playing ? .pause : .play, size: 18, color: Theme.ink)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!player.ready)
            .accessibilityLabel(player.playing ? "Pause" : "Play")
            Slider(
                value: Binding(get: { player.time }, set: { player.seek($0) }),
                in: 0...max(player.duration ?? review.duration ?? 1, 0.1)
            )
            .disabled(!player.ready && review.scenes.isEmpty)
            Text("\(clock(player.time)) / \(clock(player.duration ?? review.duration ?? 0))")
                .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
        }
    }

    private var sceneStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(review.scenes) { item in
                    let on = scene?.id == item.id
                    Button { player.seek(item.start) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            SceneThumb(source: item.thumb, session: session) { image in
                                if let source = item.thumb { stills[source] = image }
                            }
                            .frame(width: 96, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 2 : 1))
                            Text(item.title).font(.caption).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(clock(item.start)).font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
                        }
                        .frame(width: 96, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(item.title), at \(clock(item.start))")
                }
            }
        }
    }

    /* ---------- notes ---------- */

    private var noteButton: some View {
        Button {
            player.pause()
            pin = nil; quick = nil; words = ""; line = nil
            composing = true
        } label: {
            Text("Add a note at \(clock(player.time))")
                .font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity, minHeight: 44)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        }
        .buttonStyle(.plain)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Note at \(clock(player.time))\(scene.map { " · \($0.title)" } ?? "")")
                .font(.subheadline.weight(.semibold))
            Text(pin == nil ? "Tap the frame to point at a spot (optional)." : "Spot pinned. Tap again to move it.")
                .font(.footnote).foregroundStyle(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(review.quick, id: \.self) { chip in
                        let on = quick == chip
                        Button { quick = on ? nil : chip } label: {
                            Text(chip).font(.subheadline)
                                .foregroundStyle(on ? Theme.primaryText : Theme.ink)
                                .padding(.horizontal, 12).frame(minHeight: 34)
                                .background(on ? Theme.primaryFill : Theme.surfaceRaised, in: Capsule())
                                .overlay(Capsule().stroke(Theme.line))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
                    }
                }
            }
            TextField("What should change here?", text: $words, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
            HStack(spacing: 10) {
                Button("Cancel") { composing = false; pin = nil }
                    .font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
                    .frame(minHeight: 44)
                Spacer()
                Button {
                    let t = player.time
                    send(type: "comment", value: .note(t: t, scene: scene?.id, x: pin.map { Double($0.x) }, y: pin.map { Double($0.y) }, quick: quick), note: text) {
                        composing = false; pin = nil
                    }
                } label: {
                    Text(sending ? "Sending…" : "Send note").font(.subheadline.weight(.semibold))
                        .foregroundStyle(text.isEmpty && quick == nil ? Theme.muted : Theme.primaryText)
                        .padding(.horizontal, 18).frame(minHeight: 44)
                        .background(text.isEmpty && quick == nil ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled((text.isEmpty && quick == nil) || sending)
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    private var notesList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("NOTES").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            ForEach(review.notes) { note in
                Button { if let t = note.t { player.seek(t) } } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Lucide(note.state == "resolved" ? .circleCheck : .pin, size: 14,
                               color: note.state == "resolved" ? Theme.muted : Theme.ink)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(note.text).font(.subheadline).foregroundStyle(Theme.ink)
                            if let resolution = note.resolution, !resolution.isEmpty {
                                Text(resolution).font(.footnote).foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer(minLength: 0)
                        if let t = note.t { Text(clock(t)).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(note.state == "resolved" ? "Done" : "Open") note\(note.t.map { " at \(clock($0))" } ?? ""): \(note.text)")
            }
        }
    }

    /* ---------- closing the call ---------- */

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !closed {
                if !openNotes.isEmpty {
                    primary("Apply \(openNotes.count) note\(openNotes.count == 1 ? "" : "s")") {
                        send(type: "apply", value: WorkflowCommand.Value.none) { closed = true }
                    }
                } else if review.finish.contains("approve") {
                    primary(review.kind == "animatic" ? "Looks right, build it" : "Looks right") {
                        send(type: "approve", value: WorkflowCommand.Value.none) { closed = true }
                    }
                } else if review.finish.contains("render") {
                    primary("Render the final") { send(type: "choose", value: .id("render")) { closed = true } }
                }
                if openNotes.isEmpty, review.finish.contains("preview") {
                    Button { send(type: "choose", value: .id("preview")) { closed = true } } label: {
                        Text("Preview first").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    }
                    .buttonStyle(.plain)
                    .disabled(sending)
                }
            }
            if let line {
                Text(line.text).font(.footnote).foregroundStyle(line.delivered ? Theme.muted : Theme.needsYou)
            } else {
                Text("Notes go to RasanAI as you leave them; nothing changes until you apply them.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if sending { ProgressView().tint(Theme.primaryText) }
                Text(sending ? "Sending…" : title).font(.body.weight(.semibold))
            }
            .foregroundStyle(Theme.primaryText)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Theme.primaryFill, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(sending)
    }

    private func send(type: String, value: WorkflowCommand.Value?, note: String? = nil, then done: @escaping () -> Void) {
        sending = true
        Task {
            let outcome = await model.act(on: session, type: type, value: value, note: note)
            sending = false
            if !outcome.line.isEmpty { line = (outcome.delivered, outcome.line) }
            if outcome.delivered { done() }
        }
    }
}

func clock(_ seconds: Double) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    return "\(whole / 60):" + String(format: "%02d", whole % 60)
}

/// The player behind the card: AVPlayer for the film or the soundtrack, time kept for the UI.
@MainActor @Observable
final class ReviewPlayer {
    let avPlayer = AVPlayer()
    private(set) var time: Double = 0
    private(set) var duration: Double?
    private(set) var playing = false
    private(set) var ready = false
    private(set) var isVideo = false
    @ObservationIgnored private var observer: Any?

    func load(_ url: URL, video: Bool) {
        isVideo = video
        let item = AVPlayerItem(url: url)
        avPlayer.replaceCurrentItem(with: item)
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        if observer == nil {
            observer = avPlayer.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] now in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.time = now.seconds.isFinite ? now.seconds : 0
                    if let seconds = self.avPlayer.currentItem?.duration.seconds, seconds.isFinite { self.duration = seconds }
                    self.playing = self.avPlayer.rate > 0
                }
            }
        }
        ready = true
        avPlayer.play()
    }

    func toggle() { if avPlayer.rate > 0 { pause() } else { avPlayer.play(); playing = true } }
    func pause() { avPlayer.pause(); playing = false }

    /// Before the film is here, scrubbing still moves through the animatic's stills.
    func seek(_ seconds: Double) {
        time = seconds
        guard ready else { return }
        avPlayer.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
}

/// The frame: the player's own layer for a film, the scene's still for the animatic; taps are
/// mapped to fractions of the picture itself (not its letterbox), as RasanAI pins notes.
private struct ReviewSurface: UIViewRepresentable {
    let player: AVPlayer?
    let still: UIImage?
    let pin: CGPoint?
    let pinning: Bool
    let onPin: (CGPoint) -> Void

    func makeUIView(context: Context) -> SurfaceView {
        let view = SurfaceView()
        view.onPin = onPin
        return view
    }

    func updateUIView(_ view: SurfaceView, context: Context) {
        view.onPin = onPin
        view.pinning = pinning
        view.playerLayer.player = player
        view.imageView.image = still
        view.imageView.isHidden = player != nil
        view.pin = pin
    }

    final class SurfaceView: UIView {
        let playerLayer = AVPlayerLayer()
        let imageView = UIImageView()
        private let marker = UIView()
        var onPin: ((CGPoint) -> Void)?
        var pinning = false
        var pin: CGPoint? { didSet { setNeedsLayout() } }

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .black
            playerLayer.videoGravity = .resizeAspect
            layer.addSublayer(playerLayer)
            imageView.contentMode = .scaleAspectFit
            addSubview(imageView)
            marker.layer.borderColor = UIColor.white.cgColor
            marker.layer.borderWidth = 3
            marker.layer.cornerRadius = 14
            marker.backgroundColor = UIColor.systemRed.withAlphaComponent(0.35)
            marker.isUserInteractionEnabled = false
            addSubview(marker)
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        }

        required init?(coder: NSCoder) { nil }

        /// Where the picture actually is inside the view.
        private var pictureRect: CGRect {
            if playerLayer.player != nil, !playerLayer.videoRect.isEmpty { return playerLayer.videoRect }
            if let image = imageView.image, image.size.width > 0 { return AVMakeRect(aspectRatio: image.size, insideRect: bounds) }
            return bounds
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            playerLayer.frame = bounds
            imageView.frame = bounds
            if let pin {
                let rect = pictureRect
                marker.isHidden = false
                marker.frame = CGRect(x: rect.minX + pin.x * rect.width - 14, y: rect.minY + pin.y * rect.height - 14, width: 28, height: 28)
            } else {
                marker.isHidden = true
            }
        }

        @objc private func tapped(_ gesture: UITapGestureRecognizer) {
            guard pinning else { return }
            let rect = pictureRect
            let point = gesture.location(in: self)
            guard rect.contains(point), rect.width > 0, rect.height > 0 else { return }
            onPin?(CGPoint(x: (point.x - rect.minX) / rect.width, y: (point.y - rect.minY) / rect.height))
        }
    }
}

/// A scene's still, from the Mac; it also feeds the animatic's frame.
private struct SceneThumb: View {
    @Environment(AppModel.self) private var model
    let source: String?
    let session: PhoneSnapshot.Session
    let loaded: (UIImage) -> Void
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Theme.surfaceRaised
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .task(id: source) {
            guard let source, image == nil else { return }
            if case let .image(found) = await model.loadImage(session, source: source) {
                image = found
                loaded(found)
            }
        }
    }
}
#endif
