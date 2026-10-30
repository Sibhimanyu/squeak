import LocalAuthentication
import SqueakMacCore
import SwiftUI

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

    private var m: ChannelsModel { app.channels }

    var body: some View {
        Form {
            if let v = m.voice, v.isOn {
                Section {
                    LabeledContent {
                        HStack {
                            TextField("", text: $typed, prompt: Text(v.defaultCallee ?? "101"))
                                .textFieldStyle(.roundedBorder).frame(width: 110)
                                .onSubmit(save)
                            Button("Save", action: save).disabled(!changed(v) || m.voiceSaving)
                        }
                    } label: {
                        Text("Extension to ring")
                        Text("Your phone's extension in 3CX, like 101.")
                    }
                    if let e = m.voiceError { Footnote(e) }
                } header: { Text("Phone calls") } footer: {
                    Footnote(footnote(v))
                }
                if v.pauseKnown { pauseSection(v) }
                if let natural = v.natural { naturalSection(natural) }
                callsSection
                if m.gatewayAvailable { gatewaySection }
                if let state = v.pinState { pinSection(state) }
                if let policy = v.policy { policySection(policy) }
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
        .sheet(isPresented: $pairingGateway, onDismiss: { m.endGatewayPairing() }) { GatewayPairSheet().environment(app) }
        .sheet(isPresented: $showingCalls) { CallsSheet().environment(app) }
        .task {
            await m.refreshVoice()
            if !loaded { typed = m.voice?.callee ?? ""; loaded = true }
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

    // MARK: Natural voice

    private func naturalSection(_ n: NaturalVoice) -> some View {
        Section {
            if n.installed {
                Toggle(isOn: Binding(get: { n.enabled }, set: { on in Task { await m.setNatural(enabled: on) } })) {
                    Text("Speak with this Mac's voice")
                    Text("A realistic voice made on this Mac, played in the call.")
                }
                .disabled(m.pauseBusy)
                if n.enabled {
                    Picker("Voice", selection: Binding(get: { n.voice }, set: { id in Task { await m.setNatural(voice: id) } })) {
                        ForEach(NaturalVoice.voices, id: \.id) { Text($0.title).tag($0.id) }
                        if !NaturalVoice.voices.contains(where: { $0.id == n.voice }) { Text(n.voice).tag(n.voice) }
                    }
                    .disabled(m.pauseBusy)
                }
            } else {
                LabeledContent {
                    Text("squeak voice-tts-setup").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                } label: {
                    Text("Realistic voice")
                    Text("Not installed. Run this in Terminal once (about 350 MB); calls use it afterwards.")
                }
            }
        } header: { Text("Voice") } footer: {
            Footnote("Made on this Mac; the words never leave it. If it fails, the plain voice speaks and the call still goes.")
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
            HStack {
                Button(g.isPaired ? "Pair again" : "Add gateway") { pairingGateway = true }.disabled(m.gatewayConnecting)
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
                    Footnote("No PIN is set, so a call can only tell you, never take an answer.")
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
            Footnote("The PIN is asked on the call before a key answers it. It is kept by whatever places the call, never in this app.")
        }
    }

    // MARK: Policy

    private func policySection(_ p: PinPolicy) -> some View {
        Section {
            policyRow("Calls Squeak makes to you", p.outgoing) { setPolicy(PinPolicy(outgoing: $0, incoming: p.incoming), current: p) }
            if p.outgoing == .skip { Footnote("Anyone who answers your phone could then answer your agents.") }
            policyRow("Calls you make to Squeak", p.incoming) { setPolicy(PinPolicy(outgoing: p.outgoing, incoming: $0), current: p) }
            if let e = m.pinError { Footnote(e) }
            if let n = m.pinNotice, pinForm == nil { Footnote(n) }
        } header: { Text("When Squeak asks for the PIN") } footer: {
            Footnote("Changing a call to Don't ask needs Touch ID or this Mac's password.")
        }
    }

    private func policyRow(_ label: String, _ value: PinPolicyChoice, _ change: @escaping (PinPolicyChoice) -> Void) -> some View {
        LabeledContent(label) {
            Picker("", selection: Binding(get: { value }, set: { change($0) })) {
                Text("Ask for the PIN").tag(PinPolicyChoice.ask)
                Text("Don't ask").tag(PinPolicyChoice.skip)
            }.labelsHidden().pickerStyle(.menu).fixedSize().disabled(m.pinBusy || ownerChecking)
        }
    }

    private func setPolicy(_ next: PinPolicy, current: PinPolicy) {
        m.clearPinMessages()
        guard next != current else { return }
        let loosening = (next.outgoing == .skip && current.outgoing != .skip) || (next.incoming == .skip && current.incoming != .skip)
        if !loosening { Task { await m.setPinPolicy(outgoing: next.outgoing, incoming: next.incoming) }; return }
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
                if ok { await m.setPinPolicy(outgoing: next.outgoing, incoming: next.incoming) }
                else { m.reportPinError("It was not confirmed that it is you, so nothing changed.") }
            }
        }
    }

    private func pinButtons<A: View>(_ a: A) -> some View { HStack { a; Spacer() } }
    private func pinButtons<A: View, B: View>(_ a: A, _ b: B) -> some View { HStack { a; b; Spacer() } }

    private func pinField(_ label: String, _ text: Binding<String>) -> some View {
        SecureField(label, text: text).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
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
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(CallText.what(e)).font(Typo.body).lineLimit(1)
                                Spacer()
                                Text(CallText.when(ms: e.at)).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                            }
                            Text("\(CallText.outcomeSentence(e)) · \(CallText.duration(ms: e.durationMs))")
                                .font(Typo.meta).foregroundStyle(e.outcome == .failed ? Theme.error : Theme.muted)
                                .fontWeight(e.outcome == .failed ? .semibold : .regular)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 8)
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
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        } else {
            Footnote("Nothing from the gateway yet. Once the Home Assistant add-on is paired and running, what it does shows here.")
        }
    }
}
