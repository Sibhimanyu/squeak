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
                if let state = v.pinState { pinSection(state) }
            } else if m.voiceOutdated {
                Section { Footnote("Squeak on this Mac is older than phone calls. Update it, then come back.") } header: { Text("Phone calls") }
            } else {
                Section {
                    Footnote("Phone calls are not set up. Squeak can ring your phone through 3CX when an agent is waiting on you: see docs/voice.md.")
                } header: { Text("Phone calls") }
            }
        }
        .settingsForm()
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
