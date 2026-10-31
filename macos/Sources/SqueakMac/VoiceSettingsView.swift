import LocalAuthentication
import SqueakMacCore
import SwiftUI

enum VoiceSettingsTarget { case extensionToRing, pin }

/// Settings › Phone calls: which extension Squeak rings when an agent is waiting on you. The PBX details live
/// where the call is placed (the Home Assistant add-on, or this Mac's config); only this one changes day to day.
struct VoiceSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var typed = ""
    @State private var loaded = false
    @State private var pinForm: PinForm?
    @State private var current = ""
    @State private var newPin = ""
    @State private var repeatPin = ""
    @State private var ownerChecking = false
    @State private var pairingGateway = false
    @State private var showingCalls = false
    @State private var preview = VoicePreview()
    @State private var personaStyle: VoicePersona.Style = .terse
    @State private var personaCustom = ""
    @FocusState private var extensionFocused: Bool
    @FocusState private var pinFocused: Bool

    private var m: ChannelsModel { app.channels }

    var body: some View {
        ScrollViewReader { proxy in
        Form {
            if let v = m.voice, v.isOn {
                Section {
                    LabeledContent {
                        HStack {
                            TextField("", text: $typed, prompt: Text(v.defaultCallee ?? "101"))
                                .textFieldStyle(.roundedBorder).frame(width: 110)
                                .focused($extensionFocused)
                                .onSubmit(save)
                            Button("Save", action: save).disabled(!changed(v) || m.voiceSaving)
                        }
                    } label: {
                        Text("Extension to ring")
                        Text("Your phone's extension in 3CX, like 101.")
                    }
                    .id("extension")
                    if let e = m.voiceError { Footnote(e) }
                } header: { Text("Phone calls") } footer: {
                    Footnote(footnote(v))
                }
                testSection(v)
                if v.pauseKnown { pauseSection(v) }
                if let persona = v.persona { personaSection(persona) }
                if let natural = v.natural { naturalSection(natural) }
                if let favorites = v.favorites { quickSection(favorites, candidates: v.workspaces ?? []) }
                callsSection
                if m.gatewayAvailable { gatewaySection }
                if let state = v.pinState { pinSection(state).id("pin") }
                if let policy = v.policy { policySection(policy, state: v.pinState) }
            } else if m.voiceOutdated {
                Section { Footnote("Squeak on this Mac is older than phone calls. Update it, then come back.") } header: { Text("Phone calls") }
            } else {
                Section {
                    Footnote("Phone calls are not set up. Squeak can ring your phone through 3CX when an agent is waiting on you: see docs/voice.md.")
                } header: { Text("Phone calls") }
                if m.gatewayAvailable { gatewaySection }
            }
        }
        .settingsForm()
        .task {
            await m.refreshVoice()
            await m.refreshNaturalSetup()
            if !loaded {
                typed = m.voice?.callee ?? ""
                if let p = m.voice?.persona { personaStyle = p.style; personaCustom = p.custom }
                loaded = true
            }
            await openRequestedControl(proxy)
        }
        }
        .onDisappear { preview.stop(); m.stopWatchingNaturalSetup() }
        .onChange(of: m.voice?.natural) { _, _ in preview.stop() }
        .sheet(isPresented: $pairingGateway, onDismiss: { m.endGatewayPairing() }) { GatewayPairSheet().environment(app) }
        .sheet(isPresented: $showingCalls) { CallsSheet().environment(app) }
    }

    private func openRequestedControl(_ proxy: ScrollViewProxy) async {
        guard let target = app.voiceSettingsTarget else { return }
        app.voiceSettingsTarget = nil
        guard let voice = m.voice, voice.isOn else { return }
        switch target {
        case .extensionToRing:
            await Task.yield()
            proxy.scrollTo("extension", anchor: .center)
            extensionFocused = true
        case .pin:
            guard let state = voice.pinState else { return }
            if state == .none || state == .off { open(.turnOn) }
            await Task.yield()
            proxy.scrollTo("pin", anchor: .center)
            if state == .none || state == .off { pinFocused = true }
        }
    }

    private func changed(_ v: VoiceSettings) -> Bool { VoiceSettings.normalized(typed) != v.callee }

    private func save() { Task { await m.setVoiceCallee(typed); typed = m.voice?.callee ?? typed } }

    private func footnote(_ v: VoiceSettings) -> String {
        let how = v.mode == "gateway" ? "The Home Assistant add-on places the call." : "This Mac places the call."
        let who = v.callee ?? v.defaultCallee
        let ringing = who.map { "Squeak rings \($0)." } ?? "No extension is set yet, so no call can be placed."
        return "\(ringing) \(how) Only an extension is accepted here, never an outside number."
    }

    // MARK: Test call

    private func testSection(_ v: VoiceSettings) -> some View {
        let busy = m.testPlacing || v.isRinging
        let blocked = v.testBlockedReason
        return Section {
            LabeledContent {
                HStack(spacing: 8) {
                    if busy { ProgressView().controlSize(.small).accessibilityLabel("Calling") }
                    Button(busy ? "Calling…" : "Call me now") { Task { await m.testCall() } }
                        .disabled(busy || blocked != nil)
                }
            } label: {
                Text("Call me now")
                Text("Rings you with a made-up question. Nothing is sent to any chat.")
            }
            if let blocked { Footnote(blocked) }
            if let e = m.testError { Footnote(e) }
            else if let line = VoiceSettings.testLine(v.lastTest) { Footnote(line) }
        } header: { Text("Test call") }
    }

    // MARK: Pause

    private func pauseSection(_ v: VoiceSettings) -> some View {
        Section {
            LabeledContent {
                Menu("Pause calls") {
                    ForEach([VoicePauseChoice.oneHour, .fourHours, .tomorrow, .forever], id: \.self) { c in
                        Button(c.menuTitle) { Task { await m.setPause(c) } }
                    }
                    if PauseText.isPaused(v.pause) {
                        Divider()
                        Button(VoicePauseChoice.resume.menuTitle) { Task { await m.setPause(.resume) } }
                    }
                }
                .fixedSize().disabled(m.pauseBusy)
            } label: {
                Text("Pause calls")
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    Text(PauseText.statusLine(v.pause, now: ctx.date))
                }
            }
        } footer: {
            Footnote("Cards still reach Telegram and the apps. A test call still rings.")
        }
    }

    // MARK: Quick workspaces

    private func quickSection(_ list: [FavoriteWorkspace], candidates: [WorkspaceChoice]) -> some View {
        Section {
            ForEach(list) { f in
                HStack(spacing: 10) {
                    Picker("Number", selection: Binding(get: { f.n }, set: { new in
                        if let next = QuickWorkspaces.renumbered(list, from: f.n, to: new) { Task { await m.setFavorites(next) } }
                    })) {
                        ForEach(QuickWorkspaces.availableNumbers(for: f.n, in: list), id: \.self) { Text("\($0)").tag($0) }
                    }
                    .labelsHidden().fixedSize().accessibilityLabel("Keypad number")
                    Picker("Workspace", selection: Binding(get: { f.workspace }, set: { key in
                        let label = candidates.first { $0.key == key }?.label ?? key
                        let next = list.map { $0.n == f.n ? FavoriteWorkspace(n: f.n, workspace: key, label: label) : $0 }
                        Task { await m.setFavorites(next) }
                    })) {
                        ForEach(candidates) { Text($0.label).tag($0.key) }
                        if !candidates.contains(where: { $0.key == f.workspace }) { Text(f.label).tag(f.workspace) }
                    }
                    .labelsHidden().accessibilityLabel("Workspace")
                    Button { Task { await m.setFavorites(list.filter { $0.n != f.n }) } } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless).accessibilityLabel("Remove \(f.label)")
                }
                .disabled(m.pauseBusy)
            }
            if candidates.isEmpty {
                Footnote("No workspaces yet \u{2014} open a chat in Conductor.")
            }
            Button("Add workspace") {
                if let next = QuickWorkspaces.added(list, candidates: candidates) { Task { await m.setFavorites(next) } }
            }
            .disabled(m.pauseBusy || QuickWorkspaces.added(list, candidates: candidates) == nil)
            if let e = m.voiceError { Footnote(e) }
        } header: { Text("Quick workspaces") } footer: {
            Footnote("On a call, Squeak reads these first. Press the number to pick the workspace, then the chat.")
        }
    }

    // MARK: Natural voice

    private func personaSection(_ saved: VoicePersona) -> some View {
        let draft = VoicePersona(style: personaStyle, custom: personaCustom)
        return Section {
            Picker("Character", selection: $personaStyle) {
                ForEach(VoicePersona.Style.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .onChange(of: personaStyle) { _, style in
                // Terse and Friendly take effect at once; Custom waits for its description and Save.
                if style != .custom { Task { await m.setPersona(VoicePersona(style: style)) } }
            }
            Footnote(personaStyle.summary)
            if personaStyle == .custom {
                TextField("", text: $personaCustom,
                          prompt: Text("e.g. Dry and blunt. Skip small talk. Say \"yep\" and \"nope\"."), axis: .vertical)
                    .lineLimit(2...5)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: personaCustom) { _, text in
                        if text.count > VoicePersona.maxCustomLength { personaCustom = String(text.prefix(VoicePersona.maxCustomLength)) }
                    }
                HStack {
                    Text("\(personaCustom.count)/\(VoicePersona.maxCustomLength)").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Save") { Task { await m.setPersona(draft) } }
                        .disabled(!draft.isSavable || m.pauseBusy || (saved.style == .custom && saved.custom == VoicePersona.cleaned(personaCustom)))
                }
            }
        } header: { Text("How it talks") } footer: {
            Footnote("Applies to the next call. It changes tone and wording only: what it can read or do on a call stays the same.")
        }
    }

    @ViewBuilder private func naturalSection(_ n: NaturalVoice) -> some View {
        if n.hasEngines { enginesSection(n) } else { kokoroOnlySection(n) }
    }

    // The daemon sent `natural.engines`: a list to choose from, with each engine's own voices and emotion.
    private func enginesSection(_ n: NaturalVoice) -> some View {
        let selected = n.currentEngineID
        let anyRunning = m.naturalSetup?.isRunning == true
        return Section {
            if n.installed {
                Toggle(isOn: Binding(get: { n.enabled }, set: { on in preview.stop(); Task { await m.setNatural(enabled: on) } })) {
                    Text("Speak with this Mac's voice")
                    Text("A realistic voice made on this Mac, played in the call.")
                }
                .disabled(m.pauseBusy)
            }
            if n.engines.contains(where: \.installed) {
                Text("Installed models").font(.callout.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(n.engines.filter(\.installed)) { engine in
                    engineRow(engine, n: n, anyRunning: anyRunning)
                }
            }
            if n.engines.contains(where: { !$0.installed }) {
                Text("More models").font(.callout.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(n.engines.filter { !$0.installed }) { engine in
                    engineRow(engine, n: n, anyRunning: anyRunning)
                }
            }
            if let engine = n.engine(selected), engine.installed {
                let options = n.voiceOptions(for: selected)
                let current = n.voice(for: selected) ?? ""
                if !options.isEmpty {
                    Picker("Voice", selection: Binding(get: { current }, set: { id in
                        preview.stop()
                        Task { await m.setNatural(voice: id) }
                    })) {
                        ForEach(options) { Text($0.label).tag($0.id) }
                        if !options.contains(where: { $0.id == current }) { Text(current).tag(current) }
                    }
                    .disabled(m.pauseBusy)
                }
                if engine.emotion {
                    Picker("Emotion", selection: Binding(get: { n.emotionLevel }, set: { level in
                        preview.stop(); Task { await m.setNatural(emotion: level) }
                    })) {
                        ForEach(NaturalEmotion.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .disabled(m.pauseBusy)
                } else {
                    Footnote(NaturalVoice.noEmotionSentence)
                }
                HStack(spacing: 8) {
                    Button {
                        if preview.active { preview.stop() }
                        else { preview.play(voice: current, engine: selected, client: m.client) }
                    } label: {
                        Label(preview.active ? "Stop sample" : "Play sample", systemImage: preview.active ? "stop.fill" : "play.fill")
                    }
                    .disabled(current.isEmpty || (m.pauseBusy && !preview.active))
                    .accessibilityLabel(preview.active ? "Stop voice sample" : "Play sample of \(engine.label)")
                    .help("Hear this voice on your Mac without placing a call.")
                    if preview.loading {
                        ProgressView().controlSize(.small).accessibilityLabel("Making voice sample")
                        Text("Making sample…").foregroundStyle(.secondary)
                    } else if preview.playing {
                        Text("Playing on this Mac").foregroundStyle(.secondary)
                    }
                }
                if let error = preview.error { Footnote(error) }
            }
            if let error = m.voiceError { Footnote(error) }
            if let note = m.naturalSetupNote { Footnote(note) }
            if let setup = m.naturalSetup, setup.state == .failed {
                Label(setup.failureLine, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(Theme.error)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
        } header: { Text("Voice") } footer: {
            Footnote("Samples play on this Mac without placing a call. The words never leave it. If speech fails during a call, the plain voice speaks and the call still goes.")
        }
    }

    private func engineRow(_ engine: NaturalEngine, n: NaturalVoice, anyRunning: Bool) -> some View {
        let inUse = engine.id == n.currentEngineID
        let setup = m.naturalSetup
        let installing = setup?.isRunning == true && setup?.concerns(engine.id) == true
        let failed = setup?.state == .failed && setup?.concerns(engine.id) == true
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                if engine.installed {
                    Button {
                        guard !inUse else { return }
                        preview.stop()
                        Task { await m.setNatural(engine: engine.id) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: inUse ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(inUse ? Theme.duck : .secondary)
                            engineDescription(engine)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(m.pauseBusy)
                    .accessibilityAddTraits(inUse ? .isSelected : [])
                } else {
                    engineDescription(engine)
                }
                Spacer(minLength: 8)
                if installing {
                    EmptyView()
                } else if !engine.installed {
                    Button(failed ? "Retry" : "Set up") { Task { await m.startNaturalSetup(engine: engine.id) } }
                        .disabled(anyRunning)
                } else if inUse {
                    Text("In use").font(.callout).foregroundStyle(.secondary)
                } else {
                    Button("Remove", role: .destructive) { Task { await m.removeNaturalEngine(engine.id) } }
                        .disabled(m.pauseBusy || anyRunning)
                }
            }
            if installing, let setup {
                if let fraction = setup.fraction { ProgressView(value: fraction) } else { ProgressView().controlSize(.small) }
                Text(setup.progressLine).font(.callout).foregroundStyle(.secondary)
                Text("You can close Settings: it keeps going. Your current voice stays in use until you choose another.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func engineDescription(_ engine: NaturalEngine) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(engine.label)
            Text([engine.summary, engine.size, engine.licence].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func kokoroOnlySection(_ n: NaturalVoice) -> some View {
        Section {
            if n.installed {
                Toggle(isOn: Binding(get: { n.enabled }, set: { on in preview.stop(); Task { await m.setNatural(enabled: on) } })) {
                    Text("Speak with this Mac's voice")
                    Text("A realistic voice made on this Mac, played in the call.")
                }
                .disabled(m.pauseBusy)
                if n.enabled {
                    Picker("Voice", selection: Binding(get: { n.voice }, set: { id in preview.stop(); Task { await m.setNatural(voice: id) } })) {
                        ForEach(NaturalVoice.voices, id: \.id) { Text($0.title).tag($0.id) }
                        if !NaturalVoice.voices.contains(where: { $0.id == n.voice }) { Text(n.voice).tag(n.voice) }
                    }
                    .disabled(m.pauseBusy)
                    HStack(spacing: 8) {
                        Button {
                            if preview.active { preview.stop() }
                            else { preview.play(voice: n.voice, client: m.client) }
                        } label: {
                            Label(preview.active ? "Stop sample" : "Play sample",
                                  systemImage: preview.active ? "stop.fill" : "play.fill")
                        }
                        .disabled(m.pauseBusy && !preview.active)
                        .accessibilityLabel(preview.active ? "Stop voice sample" : "Play sample of selected voice")
                        .help("Hear this voice on your Mac without placing a call.")
                        if preview.loading {
                            ProgressView().controlSize(.small).accessibilityLabel("Making voice sample")
                            Text("Making sample…").foregroundStyle(.secondary)
                        } else if preview.playing {
                            Text("Playing on this Mac").foregroundStyle(.secondary)
                        }
                    }
                    if let error = preview.error { Footnote(error) }
                }
            } else {
                naturalInstall(m.naturalSetup)
            }
        } header: { Text("Voice") } footer: {
            Footnote("Samples play on this Mac without placing a call. The words never leave it. If speech fails during a call, the plain voice speaks and the call still goes.")
        }
    }

    /// The install, run by the daemon: a button, then visible progress, then a clear end (the toggle appears by itself).
    @ViewBuilder private func naturalInstall(_ setup: NaturalSetupStatus?) -> some View {
        if let setup, setup.isRunning {
            VStack(alignment: .leading, spacing: 6) {
                Text("Setting up the realistic voice")
                if let fraction = setup.fraction { ProgressView(value: fraction) } else { ProgressView().controlSize(.small) }
                Text(setup.progressLine).font(.callout).foregroundStyle(.secondary)
                Text("You can close Settings: it keeps going. Calls use the plain voice until it is ready.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        } else {
            LabeledContent {
                Button(setup?.state == .failed ? "Retry" : "Set up realistic voice") { Task { await m.startNaturalSetup() } }
                    .buttonStyle(PrimaryButtonStyle())
            } label: {
                Text("Realistic voice")
                Text("Not installed. Squeak downloads it once (about 350 MB) and makes the speech on this Mac; calls use the plain voice until then.")
            }
            if let setup, setup.state == .failed {
                Label(setup.failureLine, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(Theme.error)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
            if let note = m.naturalSetupNote { Footnote(note) }
        }
    }

    // MARK: Calls

    private var callsSection: some View {
        Section {
            HStack {
                Button("Call history & log") { showingCalls = true }
                Spacer()
            }
        } header: { Text("History") } footer: {
            Footnote("Every call Squeak made, what happened, and what the gateway has been doing.")
        }
    }

    // MARK: Gateway

    private var gatewaySection: some View {
        Section {
            let g = m.gateway ?? GatewayView()
            if m.gatewayConnecting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Paired. Connecting to the add-on…").frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    Text(g.statusLine(now: ctx.date)).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if m.gatewayUpdating {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(GatewayText.updating).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if case .updated(let v) = m.gatewayUpdatePhase {
                Text(GatewayText.updated(v)).frame(maxWidth: .infinity, alignment: .leading)
            } else if m.gatewayUpdatePhase == .timedOut {
                Footnote(GatewayText.updateTimedOut)
            } else if let line = g.versionLine {
                Text(line)
                    .foregroundStyle(g.updateAvailable ? Color.primary : Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if m.gatewayCheckedNow, !m.gatewayUpdating {
                Text(GatewayText.checkedJustNow).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let e = m.gatewayError, !pairingGateway { Footnote(e) }
            HStack {
                Button(g.isPaired ? "Pair again" : "Add gateway") { pairingGateway = true }.disabled(m.gatewayConnecting || m.gatewayUpdating)
                if g.updateAvailable {
                    Button("Update add-on") { Task { await m.updateGatewayAddon() } }
                        .disabled(m.gatewayBusy || m.gatewayUpdating || m.gatewayConnecting)
                }
                if g.isPaired, !m.gatewayCheckUnavailable {
                    Button { Task { await m.checkGatewayUpdate() } } label: {
                        HStack(spacing: 6) {
                            if m.gatewayChecking { ProgressView().controlSize(.small) }
                            Text(m.gatewayUpdatePhase == .timedOut ? "Check again" : "Check for updates")
                        }
                    }
                    .disabled(m.gatewayChecking || m.gatewayUpdating || m.gatewayConnecting)
                }
                Spacer()
            }
        } header: { Text("Phone-call gateway") } footer: {
            Footnote("The Home Assistant add-on that places the call. Pairing needs no keys or addresses: just a short code.")
        }
    }

    // MARK: Pin

    private enum PinForm { case change, turnOff, turnOn, forgot, forgotNew }

    @ViewBuilder private func pinSection(_ state: PinState) -> some View {
        Section {
            switch state {
            case .set:
                if pinForm == nil || pinForm == .change || pinForm == .turnOff {
                    pinButtons(
                        Button("Change PIN") { open(.change) }.disabled(pinForm == .change),
                        Button("Turn PIN off") { open(.turnOff) }.disabled(pinForm == .turnOff))
                }
                if pinForm == .change {
                    pinField("Current PIN", $current)
                    pinField("New PIN", $newPin)
                    pinField("Repeat new PIN", $repeatPin)
                    pinActions("Change PIN", enabled: !current.isEmpty && !newPin.isEmpty) {
                        await m.changePin(current: current, new: newPin, repeated: repeatPin)
                    }
                } else if pinForm == .turnOff {
                    Footnote("Anyone who answers the call will be able to reply by key without a PIN.")
                    pinField("Current PIN", $current)
                    pinActions("Turn PIN off", enabled: !current.isEmpty) { await m.turnPinOff(current: current) }
                }
            case .off:
                if pinForm == .turnOn {
                    pinField("New PIN", $newPin)
                    pinField("Repeat new PIN", $repeatPin)
                    pinActions("Turn PIN on", enabled: !newPin.isEmpty) { await m.turnPinOn(new: newPin, repeated: repeatPin) }
                } else {
                    Footnote("The PIN is off: anyone who answers the call can reply by key.")
                    pinButtons(Button("Turn PIN on") { open(.turnOn) })
                }
            case .none:
                if pinForm == .turnOn {
                    pinField("New PIN", $newPin)
                    pinField("Repeat new PIN", $repeatPin)
                    pinActions("Set PIN", enabled: !newPin.isEmpty) { await m.turnPinOn(new: newPin, repeated: repeatPin) }
                } else {
                    Footnote("No PIN is set. Calls that require one cannot take replies.")
                    pinButtons(Button("Set a PIN") { open(.turnOn) })
                }
            case .unknown:
                Footnote("Checking…")
            }
            if state == .set || state == .unknown {
                if pinForm == .forgotNew {
                    Footnote("It is you. Choose a new PIN, or turn the PIN off.")
                    pinField("New PIN", $newPin)
                    pinField("Repeat new PIN", $repeatPin)
                    HStack {
                        Button("Set new PIN") { run { await m.resetPin(new: newPin, repeated: repeatPin) } }
                            .disabled(newPin.isEmpty || m.pinBusy)
                        Button("Turn PIN off") { run { await m.resetPin(new: nil, repeated: "") } }.disabled(m.pinBusy)
                        Button("Cancel") { close() }
                    }
                } else if pinForm != .change && pinForm != .turnOff {
                    Button("Forgot your PIN?") { forgot() }
                        .buttonStyle(.link).disabled(ownerChecking || m.pinBusy)
                }
            }
            if let e = m.pinError { Footnote(e) }
            if let n = m.pinNotice { Footnote(n) }
        } header: { Text("Pin") } footer: {
            Footnote("When required, the PIN is asked before a key answers the call. It is kept by whatever places the call, never in this app.")
        }
    }

    // MARK: Policy

    private func policySection(_ p: PinPolicy, state: PinState?) -> some View {
        Section {
            policyRow("Calls Squeak makes to you", p.outgoing, state: state, incoming: false) { setPolicy(PinPolicy(outgoing: $0, incoming: p.incoming), current: p) }
            if state == .off || ((state == .set || state == PinState.none) && p.outgoing == .skip) {
                Footnote("Anyone who answers your phone could then answer your agents.")
            }
            policyRow("Calls you make to Squeak", p.incoming, state: state, incoming: true) { setPolicy(PinPolicy(outgoing: p.outgoing, incoming: $0), current: p) }
            if let e = m.pinError { Footnote(e) }
            if let n = m.pinNotice, pinForm == nil { Footnote(n) }
        } header: { Text("Call PIN requirements") } footer: {
            Footnote(PinPolicyText.explanation(state: state))
        }
    }

    private func policyRow(_ label: String, _ value: PinPolicyChoice, state: PinState?, incoming: Bool,
                           _ change: @escaping (PinPolicyChoice) -> Void) -> some View {
        LabeledContent {
            if state == .set {
                Picker(label, selection: Binding(get: { value }, set: { change($0) })) {
                    Text("Ask for the PIN").tag(PinPolicyChoice.ask)
                    Text("Don't ask").tag(PinPolicyChoice.skip)
                }.labelsHidden().pickerStyle(.menu).fixedSize().disabled(m.pinBusy || ownerChecking)
            } else {
                Text(PinPolicyText.effective(state: state, choice: value, incoming: incoming))
                    .foregroundStyle(.secondary)
            }
        } label: {
            Text(label)
            if state != .set { Text(PinPolicyText.saved(value)) }
        }
    }

    private func setPolicy(_ next: PinPolicy, current: PinPolicy) {
        guard m.voice?.pinState == .set, m.voice?.policy == current, !m.pinBusy, !ownerChecking else { return }
        m.clearPinMessages()
        guard next != current else { return }
        let loosening = (next.outgoing == .skip && current.outgoing != .skip) || (next.incoming == .skip && current.incoming != .skip)
        if !loosening {
            Task {
                guard m.voice?.pinState == .set, m.voice?.policy == current, !m.pinBusy else { return }
                await m.setPinPolicy(outgoing: next.outgoing, incoming: next.incoming)
            }
            return
        }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            m.reportPinError("This Mac cannot check that it is you right now.")
            return
        }
        ownerChecking = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Stop asking for the Squeak call PIN") { ok, _ in
            Task { @MainActor in
                ownerChecking = false
                if ok {
                    guard m.voice?.pinState == .set, m.voice?.policy == current, !m.pinBusy else { return }
                    await m.setPinPolicy(outgoing: next.outgoing, incoming: next.incoming)
                }
                else { m.reportPinError("It was not confirmed that it is you, so nothing changed.") }
            }
        }
    }

    private func pinButtons<A: View>(_ a: A) -> some View { HStack { a; Spacer() } }
    private func pinButtons<A: View, B: View>(_ a: A, _ b: B) -> some View { HStack { a; b; Spacer() } }

    private func pinField(_ label: String, _ text: Binding<String>) -> some View {
        Group {
            if label == "New PIN" {
                SecureField(label, text: text).focused($pinFocused)
            } else {
                SecureField(label, text: text)
            }
        }
        .textFieldStyle(.roundedBorder).frame(maxWidth: 220)
    }

    private func pinActions(_ title: String, enabled: Bool, _ go: @escaping () async -> Bool) -> some View {
        HStack {
            Button(title) { run(go) }.disabled(!enabled || m.pinBusy)
            Button("Cancel") { close() }
        }
    }

    private func open(_ f: PinForm) { wipe(); m.clearPinMessages(); pinForm = f }
    private func close() { wipe(); m.clearPinMessages(); pinForm = nil }
    private func wipe() { current = ""; newPin = ""; repeatPin = "" }

    /// Runs the action; the typed PINs are cleared once it has been sent, kept only to fix a typo.
    private func run(_ go: @escaping () async -> Bool) {
        Task {
            let ok = await go()
            if ok { wipe(); pinForm = nil } else if m.pinError == nil || m.pinError?.contains("did not answer") == false { current = "" }
        }
    }

    /// "Forgot your PIN?": the owner proves it is them (Touch ID or the Mac's login password), then chooses.
    private func forgot() {
        m.clearPinMessages(); wipe()
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            m.reportPinError("This Mac cannot check that it is you right now.")
            return
        }
        ownerChecking = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Choose a new Squeak call PIN") { ok, _ in
            Task { @MainActor in
                ownerChecking = false
                if ok { pinForm = .forgotNew } else { m.reportPinError("It was not confirmed that it is you, so the PIN is unchanged.") }
            }
        }
    }
}

/// Adds the Home Assistant add-on: type the code its panel shows, confirm here. The old code-making flow stays
/// behind "Use a pairing code instead", and is what an older Squeak (no claim route) gets.
struct GatewayPairSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    @State private var typed = ""
    @State private var legacy = false
    @FocusState private var codeFocused: Bool
    private var m: ChannelsModel { app.channels }

    private var useLegacy: Bool { legacy || m.gatewayClaimUnavailable }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add a phone-call gateway").font(Typo.title)
            if useLegacy { legacyContent } else { claimContent }
            if let e = m.gatewayError { Footnote(e) }
        }
        .padding(24).frame(width: 440)
        .task(id: useLegacy) { if useLegacy && m.gatewayCode == nil { await m.startGatewayPairing() } }
    }

    @ViewBuilder private var claimContent: some View {
        let p = m.gateway?.pairing
        // Squeak restarts a moment after the approval, which clears its pairing view: this must not fall back to the code screen.
        if m.gatewayConnecting, p?.state != .request {
            connectingContent
        } else {
        switch p?.state {
        case .request:
            Text(GatewayClaimText.confirm(p!)).font(Typo.body).fixedSize(horizontal: false, vertical: true)
            approveButtons
        case .done:
            if m.gatewayConnecting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Paired. Connecting to the add-on…").font(Typo.body)
                }
                Text("Squeak restarts for a few seconds to use it. You can close this.").font(Typo.body).foregroundStyle(Theme.muted)
            } else {
                Text("Paired and connected").font(Typo.body)
            }
            Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
        default:
            Text("In Home Assistant, open the Squeak Voice panel in the sidebar. It shows a code. Type it here.")
                .font(Typo.body).fixedSize(horizontal: false, vertical: true)
            TextField("", text: $typed, prompt: Text("K7M2-QX9P"))
                .textFieldStyle(.roundedBorder).font(.system(.body, design: .monospaced))
                .focused($codeFocused).onSubmit(connect)
                .onChange(of: typed) { _, new in
                    let shown = GatewayClaim.display(new)
                    if shown != new { typed = shown }
                }
                .onAppear { codeFocused = true }
            HStack {
                Button("Connect", action: connect)
                    .buttonStyle(PrimaryButtonStyle()).disabled(!GatewayClaim.isComplete(typed) || m.gatewayBusy)
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle())
                Spacer()
                Button("Use a pairing code instead") { legacy = true }.buttonStyle(.link).font(.caption)
            }
        }
        }
    }

    private func connect() {
        guard GatewayClaim.isComplete(typed) else { return }
        Task { await m.claimGateway(code: typed) }
    }

    private var connectingContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Paired. Connecting to the add-on…").font(Typo.body)
            }
            Text("Squeak restarts for a few seconds to use it. You can close this.").font(Typo.body).foregroundStyle(Theme.muted)
            Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
        }
    }

    private var approveButtons: some View {
        HStack {
            Button("Approve") { Task { await m.approveGateway(true) } }
                .buttonStyle(PrimaryButtonStyle()).disabled(m.gatewayBusy)
            Button("Decline") { Task { await m.approveGateway(false) } }
                .buttonStyle(SecondaryButtonStyle()).disabled(m.gatewayBusy)
        }
    }

    @ViewBuilder private var legacyContent: some View {
        let p = m.gateway?.pairing
        // Squeak restarts a moment after the approval, which clears its pairing view: this must not fall back to the code screen.
        if m.gatewayConnecting, p?.state != .request {
            connectingContent
        } else {
        switch p?.state {
        case .request:
            Text(GatewayText.requestSentence(p!)).font(Typo.body).fixedSize(horizontal: false, vertical: true)
            approveButtons
        case .done:
            if m.gatewayConnecting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Paired. Connecting to the add-on…").font(Typo.body)
                }
                Text("Squeak restarts for a few seconds to use it. You can close this.").font(Typo.body).foregroundStyle(Theme.muted)
            } else {
                Text("Paired and connected").font(Typo.body)
            }
            Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
        case .expired:
            Text("The code expired").font(Typo.body)
            HStack {
                Button("New code") { Task { await m.startGatewayPairing() } }
                    .buttonStyle(PrimaryButtonStyle()).disabled(m.gatewayBusy)
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle())
            }
        default:
            if let c = m.gatewayCode {
                Text(c.code)
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                HStack {
                    Button(copied ? "Copied" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(c.code, forType: .string)
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                    }.buttonStyle(SecondaryButtonStyle())
                    Spacer()
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(GatewayText.countdown(expiresAt: p?.expiresAt ?? c.expiresAt, now: ctx.date).map { "Expires in \($0)" } ?? "Expired")
                            .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                    }
                }
                Text("Paste this into the add-on's Pairing code option in Home Assistant. It works for 10 minutes.")
                    .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            } else if m.gatewayError == nil {
                Text("Making a code…").font(Typo.body).foregroundStyle(Theme.muted)
            }
            HStack {
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle())
                Spacer()
                if !m.gatewayClaimUnavailable {
                    Button("Type the add-on's code instead") { legacy = false }.buttonStyle(.link).font(.caption)
                }
            }
        }
        }
    }
}

/// Call history and the gateway's log: Calls | Gateway log, refreshed every 10 s while open.
struct CallsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var tab = Tab.calls
    @State private var copied = false
    private var m: ChannelsModel { app.channels }

    private enum Tab: String, CaseIterable { case calls = "Calls", log = "Gateway log" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Call history & log").font(Typo.title)
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).labelsHidden()
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            HStack {
                Button(copied ? "Copied" : "Copy") { copy() }
                    .buttonStyle(SecondaryButtonStyle()).disabled(exportText.isEmpty)
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(24).frame(width: 560, height: 480)
        .onAppear { m.startCallsRefresh() }
        .onDisappear { m.stopCallsRefresh() }
    }

    private var exportText: String {
        guard let v = m.calls else { return "" }
        switch tab {
        case .calls: return CallText.callsExport(v.calls)
        case .log: return v.gatewayLog.map { CallText.logExport($0) } ?? ""
        }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(exportText, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }

    @ViewBuilder private var content: some View {
        if !m.callsAvailable {
            Footnote(CallText.unavailable)
        } else if let v = m.calls {
            switch tab {
            case .calls: callsList(v.calls)
            case .log: logList(v.gatewayLog)
            }
        } else {
            Text("Loading…").font(Typo.body).foregroundStyle(Theme.muted)
        }
    }

    @ViewBuilder private func callsList(_ calls: [CallEntry]) -> some View {
        if calls.isEmpty {
            Footnote("No calls yet. When an agent is waiting on you, or you place a test call, it shows here.")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(calls) { e in
                        CallRow(entry: e)
                        Divider().overlay(Theme.line)
                    }
                }
            }
        }
    }

    @ViewBuilder private func logList(_ log: GatewayLog?) -> some View {
        if let log, !log.lines.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(log.lines.reversed()) { l in
                        Text(CallText.logLine(l))
                            .font(.system(.caption, design: .monospaced))
                            .fontWeight(l.level == .warn ? .bold : .regular)
                            .foregroundStyle(l.level == .warn ? Theme.error : Theme.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        } else {
            Footnote("Nothing from the gateway yet. Once the Home Assistant add-on is paired and running, what it does shows here.")
        }
    }
}


/// One call: its summary row, and when opened the timeline of what happened, with a Copy of it as plain text.
struct CallRow: View {
    let entry: CallEntry
    @State private var open = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy(duration: 0.15)) { open.toggle() } } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 10).padding(.top, 4)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(CallText.what(entry)).font(Typo.body).lineLimit(1)
                            Spacer()
                            Text(CallText.when(ms: entry.at)).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                        }
                        Text("\(CallText.outcomeSentence(entry)) \u{00B7} \(CallText.duration(ms: entry.durationMs))")
                            .font(Typo.meta).foregroundStyle(entry.outcome == .failed ? Theme.error : Theme.muted)
                            .fontWeight(entry.outcome == .failed ? .semibold : .regular)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(CallText.callRow(entry))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { detail.padding(.leading, 18) }
        }
        .padding(.vertical, 8)
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(CallText.summary(entry)).font(Typo.meta).foregroundStyle(Theme.muted).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if entry.events.isEmpty {
                Text("No detail was recorded for this call.").font(Typo.meta).foregroundStyle(Theme.muted)
            } else {
                ForEach(entry.events) { ev in eventLine(ev) }
            }
            Button(copied ? "Copied" : "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(CallText.timelineExport(entry), forType: .string)
                copied = true
                Task { try? await Task.sleep(for: .seconds(2)); copied = false }
            }
            .buttonStyle(SecondaryButtonStyle())
        }
    }

    private func eventLine(_ ev: CallEvent) -> some View {
        let warn = ev.kind == .warn
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(CallText.eventTime(ev.at)).font(.system(.caption, design: .monospaced)).foregroundStyle(Theme.muted)
            Text(CallText.sourceTag(ev.source)).font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                .padding(.horizontal, 5).padding(.vertical, 1).background(Theme.surface, in: Capsule())
            Image(systemName: icon(ev.kind)).font(.caption).foregroundStyle(warn ? Theme.error : Theme.muted)
                .help(CallText.kindLabel(ev.kind)).accessibilityLabel(CallText.kindLabel(ev.kind))
            Text(CallText.eventBody(ev))
                .font(ev.kind == .step ? .system(.caption, design: .monospaced) : .caption)
                .fontWeight(warn ? .semibold : .regular)
                .foregroundStyle(warn ? Theme.error : Theme.ink)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let ms = ev.ms {
                Text(CallText.eventDuration(ms: ms)).font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 5).padding(.vertical, 1).background(Theme.surface, in: Capsule())
            }
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
