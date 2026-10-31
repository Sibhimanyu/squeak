#if os(iOS)
import SqueakCore
import AVFoundation
import Observation
import SwiftUI
import UIKit

/// Settings › Phone calls › Voice: the realistic voice, as on the Mac. Shown only for a Mac that sends
/// `natural.voices`; an older Mac would refuse the commands. "Play sample" shows only when the Mac says
/// `natural.sample` (it can leave the sound in the channel); the Mac makes it, this phone plays it.
struct NaturalVoiceSection: View {
    @Environment(AppModel.self) private var model
    let natural: NaturalVoiceView
    @State private var busy = false
    @State private var problem: String?
    @State private var sample = VoiceSamplePlayer()

    var body: some View {
        Section {
            if natural.installed {
                Toggle(isOn: Binding(get: { natural.enabled }, set: { on in send(.natural(enabled: on, voice: nil)) })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(VoiceParityText.naturalTitle)
                        Text(VoiceParityText.naturalDetail).font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
                .disabled(busy)
                .frame(minHeight: 44)
                if natural.enabled {
                    if natural.hasEngines { engineRows }
                    let voices = natural.currentVoices
                    HStack {
                        Text("Voice")
                        Spacer()
                        Picker("Voice", selection: Binding(get: { natural.voice }, set: { id in
                            if id != natural.voice { send(.natural(enabled: nil, voice: id)) }
                        })) {
                            ForEach(voices) { Text($0.label).tag($0.id) }
                            // A voice this list does not name shows as its raw id.
                            if !voices.contains(where: { $0.id == natural.voice }) { Text(natural.voice).tag(natural.voice) }
                        }
                        .labelsHidden()
                        .disabled(busy)
                    }
                    .frame(minHeight: 44)
                    if natural.showsEmotion { emotionRow }
                    if natural.sample == true { sampleRow }
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Realistic voice")
                    Text(VoiceParityText.notInstalled).font(.footnote).foregroundStyle(Theme.muted)
                    Text(VoiceParityText.installCommand)
                        .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
        } header: { Text("Voice") } footer: {
            Text(VoiceParityText.voiceFooter)
        }
    }

    /// Keep model choice together on its own screen, including models that need installation on the Mac.
    private var engineRows: some View {
        NavigationLink {
            enginePicker
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "waveform")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Voice model")
                    if let engine = natural.currentEngine {
                        Text(engine.label).font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
            }
            .frame(minHeight: 44)
        }
        .disabled(busy)
    }

    private var enginePicker: some View {
        List {
            Section {
                ForEach(natural.pickableEngines) { engine in
                    Button {
                        if engine.id != natural.currentEngine?.id {
                            send(.natural(enabled: nil, voice: nil, engine: engine.id))
                        }
                    } label: {
                        engineRow(engine, selected: engine.id == natural.currentEngine?.id)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityAddTraits(engine.id == natural.currentEngine?.id ? .isSelected : [])
                }
            } header: {
                Text("Installed on your Mac")
            } footer: {
                Text("Choose the model that speaks during phone calls.")
            }
            if !natural.greyedEngines.isEmpty {
                Section {
                    ForEach(natural.greyedEngines) { engine in
                        engineRow(engine, selected: false, unavailable: true)
                    }
                } header: {
                    Text("More models")
                } footer: {
                    Text("Install these models in Phone calls settings on your Mac.")
                }
            }
            if let problem {
                Section { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Voice model")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func engineRow(_ engine: NaturalVoiceView.EngineChoice, selected: Bool, unavailable: Bool = false) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(engine.label).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                if !engine.summary.isEmpty {
                    Text(engine.summary).font(.footnote).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if unavailable {
                    Text(engine.size.isEmpty ? VoiceParityText.engineGreyed : "\(VoiceParityText.engineGreyed) · \(engine.size)")
                        .font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 8)
            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Theme.done)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var emotionRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(VoiceParityText.emotionTitle)
                Spacer()
                Picker(VoiceParityText.emotionTitle, selection: Binding(get: { natural.emotionLevel }, set: { level in
                    if level != natural.emotionLevel { send(.natural(enabled: nil, voice: nil, emotion: level)) }
                })) {
                    ForEach(EmotionLevel.all, id: \.self) { Text(EmotionLevel.label($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
                .disabled(busy)
            }
            .frame(minHeight: 44)
            Text(VoiceParityText.emotionFooter).font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private var sampleRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Button {
                    if sample.active { sample.stop() } else { sample.play(voice: natural.voice, engine: natural.sampleEngine, model: model) }
                } label: {
                    Label(sample.active ? VoiceParityText.sampleStop : VoiceParityText.samplePlay,
                          systemImage: sample.active ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(sample.active ? "Stop voice sample" : "Play sample of selected voice")
                if sample.loading {
                    ProgressView().controlSize(.small).accessibilityLabel("Making voice sample")
                    Text(VoiceParityText.sampleMaking).font(.footnote).foregroundStyle(Theme.muted)
                } else if sample.playing {
                    Text(VoiceParityText.samplePlaying).font(.footnote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            if let line = sample.error { Text(line).font(.footnote).foregroundStyle(Theme.muted) }
        }
        // A different voice or leaving the page ends the sample; a late answer never plays.
        .onChange(of: natural.voice) { _, _ in sample.stop() }
        .onChange(of: natural.engine) { _, _ in sample.stop() }
        .onChange(of: natural.emotion) { _, _ in sample.stop() }
        .onDisappear { sample.stop() }
    }

    private func send(_ change: VoiceChange) {
        sample.stop()
        problem = nil
        busy = true
        Task {
            problem = await model.changeVoice(change)
            busy = false
        }
    }
}

/// Settings › Phone calls › Quick workspaces: keypad digit to workspace, saved as the whole list each time.
struct QuickWorkspacesSection: View {
    @Environment(AppModel.self) private var model
    let list: [FavoriteWorkspace]
    let candidates: [WorkspaceChoice]
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        Section {
            ForEach(list) { f in row(f) }
            if candidates.isEmpty { Text(VoiceParityText.noWorkspaces).font(.footnote).foregroundStyle(Theme.muted) }
            Button("Add workspace") {
                if let next = QuickWorkspaces.added(list, candidates: candidates) { save(next) }
            }
            .disabled(busy || QuickWorkspaces.added(list, candidates: candidates) == nil)
            .frame(minHeight: 44)
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
        } header: { Text("Quick workspaces") } footer: {
            Text(VoiceParityText.quickFooter)
        }
    }

    private func row(_ f: FavoriteWorkspace) -> some View {
        HStack(spacing: 8) {
            Picker("Keypad number", selection: Binding(get: { f.n }, set: { new in
                if let next = QuickWorkspaces.renumbered(list, from: f.n, to: new) { save(next) }
            })) {
                ForEach(QuickWorkspaces.availableNumbers(for: f.n, in: list), id: \.self) { Text("\($0)").tag($0) }
            }
            .labelsHidden().fixedSize().disabled(busy)
            Picker("Workspace", selection: Binding(get: { f.workspace }, set: { key in
                guard key != f.workspace, let choice = candidates.first(where: { $0.key == key }) else { return }
                save(QuickWorkspaces.replaced(list, n: f.n, with: choice))
            })) {
                ForEach(candidates) { Text($0.label).tag($0.key) }
                if !candidates.contains(where: { $0.key == f.workspace }) { Text(f.label).tag(f.workspace) }
            }
            .labelsHidden().lineLimit(1).disabled(busy)
            Spacer(minLength: 0)
            Button { save(QuickWorkspaces.removed(list, n: f.n)) } label: {
                Image(systemName: "minus.circle").frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless).disabled(busy)
            .accessibilityLabel("Remove \(f.label)")
        }
        .frame(minHeight: 44)
    }

    private func save(_ next: [FavoriteWorkspace]) {
        guard QuickWorkspaces.isValid(next, offered: candidates, saved: list) else {
            problem = "That list can't be saved."
            return
        }
        problem = nil
        busy = true
        Task {
            problem = await model.changeVoice(.favorites(next))
            busy = false
        }
    }
}

/// Settings › Phone calls › History: opens the call log. The Mac sends `voice.calls` only while this page is open.
struct CallHistorySection: View {
    var body: some View {
        Section {
            NavigationLink { CallsView() } label: {
                Text("Call history & log").frame(minHeight: 44, alignment: .leading)
            }
        } header: { Text("History") } footer: {
            Text(VoiceParityText.historyFooter)
        }
    }
}

struct CallsView: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false

    private var calls: [CallEntry]? { model.snapshot?.voice?.calls }

    private var silent: Bool {
        if case .silent = model.macLiveness() { return true }
        return false
    }

    var body: some View {
        List {
            if let calls {
                if calls.isEmpty {
                    Text(CallText.empty).font(.footnote).foregroundStyle(Theme.muted)
                } else {
                    ForEach(calls) { CallRow(entry: $0) }
                }
            } else if silent {
                Text("Your Mac isn't answering.").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                // The Mac answers with the next view once presence names "calls"; an older Mac never does.
                HStack(spacing: 10) {
                    ProgressView()
                    Text(CallText.loading).font(.footnote).foregroundStyle(Theme.muted)
                }
                Text(CallText.unavailable).font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Call history & log")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = CallText.fullExport(calls ?? [])
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                }
                .disabled((calls ?? []).isEmpty)
            }
        }
        .onAppear { model.setCallsOpen(true) }
        .onDisappear { model.setCallsOpen(false) }
    }
}

/// One call: its summary, and when opened the timeline of what happened, with a Copy of it.
private struct CallRow: View {
    let entry: CallEntry
    @State private var open = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy(duration: 0.15)) { open.toggle() } } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 12).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(CallText.what(entry)).font(.body).lineLimit(1)
                            Spacer(minLength: 4)
                            Text(CallText.when(ms: entry.at)).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                        }
                        Text("\(CallText.outcomeSentence(entry)) \u{00B7} \(CallText.duration(ms: entry.durationMs))")
                            .font(.footnote)
                            .foregroundStyle(entry.outcome == .failed ? Theme.needsYou : Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(CallText.callRow(entry))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { detail }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(CallText.summary(entry)).font(.footnote).foregroundStyle(Theme.muted).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if entry.events.isEmpty {
                Text("No detail was recorded for this call.").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                ForEach(entry.events) { event($0) }
            }
            Button(copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = CallText.timelineExport(entry)
                copied = true
                Task { try? await Task.sleep(for: .seconds(2)); copied = false }
            }
            .buttonStyle(.bordered).frame(minHeight: 44)
        }
        .padding(.leading, 20)
    }

    private func event(_ ev: CallEvent) -> some View {
        let warn = ev.kind == .warn
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(CallText.eventTime(ev.at)).font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.muted)
                Text(CallText.sourceTag(ev.source)).font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 5).padding(.vertical, 1).background(Theme.surface, in: Capsule())
                Image(systemName: icon(ev.kind)).font(.caption2).foregroundStyle(warn ? Theme.needsYou : Theme.muted)
                    .accessibilityLabel(CallText.kindLabel(ev.kind))
            }
            Text(CallText.eventBody(ev))
                .font(ev.kind == .step ? .system(.caption, design: .monospaced) : .caption)
                .fontWeight(warn ? .semibold : .regular)
                .foregroundStyle(warn ? Theme.needsYou : Theme.ink)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func icon(_ k: CallEventKind) -> String {
        switch k {
        case .step: "gearshape"
        case .said: "speaker.wave.2"
        case .heard: "mic"
        case .key: "number.square"
        case .warn: "exclamationmark.triangle"
        }
    }
}

/// Owns one voice sample: asks the Mac, plays what comes back, and drops a late answer after `stop()`.
/// Plays with the `.playback` category like the film and soundtrack do, so the ring/silent switch does not mute it.
@MainActor @Observable
final class VoiceSamplePlayer: NSObject, AVAudioPlayerDelegate {
    private(set) var loading = false
    private(set) var playing = false
    private(set) var error: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var generation = 0

    var active: Bool { loading || playing }

    func play(voice: String, engine: String? = nil, model: AppModel) {
        stop()
        loading = true
        let request = generation
        task = Task { [weak self] in
            let answer = await model.loadVoiceSample(voice, engine: engine)
            guard let self, !Task.isCancelled, self.generation == request else { return }
            switch answer {
            case .refused(let reason):
                self.loading = false
                self.error = reason
            case .audio(let data):
                do {
                    try? AVAudioSession.sharedInstance().setCategory(.playback)
                    try? AVAudioSession.sharedInstance().setActive(true)
                    let player = try AVAudioPlayer(data: data)
                    player.delegate = self
                    self.player = player
                    guard player.play() else { throw CocoaError(.fileReadCorruptFile) }
                    self.loading = false
                    self.playing = true
                } catch {
                    self.player = nil
                    self.loading = false
                    self.error = VoiceParityText.sampleFailed
                }
            }
        }
    }

    func stop() {
        generation += 1
        task?.cancel()
        task = nil
        player?.stop()
        player = nil
        loading = false
        playing = false
        error = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self, let current = self.player, ObjectIdentifier(current) == identity else { return }
            self.player = nil
            self.playing = false
            if !flag { self.error = VoiceParityText.sampleBroke }
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self, let current = self.player, ObjectIdentifier(current) == identity else { return }
            self.stop()
            self.error = VoiceParityText.sampleBroke
        }
    }
}
#endif
