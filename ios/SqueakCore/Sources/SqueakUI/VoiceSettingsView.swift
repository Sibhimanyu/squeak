#if os(iOS)
import SqueakCore
import SwiftUI
import UIKit

/// Settings › Phone calls: the extension Squeak rings when an agent is waiting on you, and a test call. The Mac
/// owns the setting (`voice` in the phone view) and only accepts an internal extension; a test touches no chat.
struct VoiceSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var loaded = false
    @State private var saving = false
    @State private var testing = false
    @State private var problem: String?
    @State private var currentPin = ""
    @State private var newPin = ""
    @State private var repeatPin = ""
    @State private var changingPin = false
    @State private var pinNote: String?
    private enum PinField: Hashable { case callee, current, new, repeatPin }
    @FocusState private var focused: PinField?

    private var voice: VoiceView? { model.snapshot?.voice }
    private var shownCallee: String { voice?.callee ?? "" }
    private var changed: Bool { VoiceFormat.normalized(typed) != voice?.callee }
    private var valid: Bool { VoiceFormat.normalized(typed).map(VoiceFormat.isExtension) ?? true }
    private var ringing: Bool { voice?.lastTest?.status == "ringing" }
    private var pinReady: Bool {
        VoiceFormat.isPin(currentPin) && VoiceFormat.isPin(newPin) && newPin == repeatPin && newPin != currentPin
    }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering. Changes won't reach it.").font(.footnote).foregroundStyle(Theme.muted) }
            }
            if let voice, voice.isOn {
                Section {
                    HStack {
                        TextField(voice.defaultCallee ?? "101", text: $typed)
                            .keyboardType(.numberPad).focused($focused, equals: .callee)
                            .settingsInput(isFocused: focused == .callee)
                            .accessibilityLabel("Extension to ring")
                        Button(saving ? "Saving…" : "Save", action: save)
                            .disabled(!changed || !valid || saving)
                            .buttonStyle(.borderedProminent)
                    }
                } header: { Text("Extension to ring") } footer: {
                    Text(valid
                         ? "Your phone's extension in 3CX, like 101. Only an extension is accepted, never an outside number."
                         : "An extension is 2 to 6 digits, like 101.")
                }
                Section {
                    Button { test() } label: {
                        HStack {
                            Label(ringing || testing ? "Calling…" : "Call me now", systemImage: "phone")
                            Spacer()
                            if ringing || testing { ProgressView() }
                        }
                    }
                    .disabled(ringing || testing || (voice.callee == nil && voice.defaultCallee == nil))
                    .frame(minHeight: 44)
                    if let line = VoiceFormat.testLine(voice.lastTest) {
                        Text(line).font(.footnote).foregroundStyle(Theme.muted)
                    }
                } header: { Text("Test call") } footer: {
                    Text("Rings you with a made-up question. Nothing is sent to any chat.")
                }
                // The pin lives in the Home Assistant add-on; the Mac only passes a change on, never keeps it.
                if voice.mode == "gateway" {
                    Section {
                        pinField("Current PIN", text: $currentPin, field: .current, contentType: .password)
                        pinField("New PIN", text: $newPin, field: .new, contentType: .newPassword)
                        pinField("Repeat new PIN", text: $repeatPin, field: .repeatPin, contentType: .newPassword)
                        Button(changingPin ? "Changing…" : "Change pin", action: changePin)
                            .disabled(!pinReady || changingPin)
                            .buttonStyle(PrimaryButtonStyle())
                        if let pinNote { Text(pinNote).font(.footnote).foregroundStyle(Theme.muted) }
                    } header: { Text("Pin") } footer: {
                        Text("The pin you key in on a call, 4 to 12 digits. It needs your current pin, and is kept on Home Assistant, not on your Mac.")
                    }
                }
                Section { Text(VoiceFormat.modeLine(voice)).font(.footnote).foregroundStyle(Theme.muted) }
            } else {
                Section {
                    Text(voice.map(VoiceFormat.modeLine) ?? "Phone calls need a newer Squeak on your Mac.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            if let problem {
                Section { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Phone calls")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .onAppear {
            // What the Mac has, once: never over what is being typed.
            if !loaded { typed = shownCallee; loaded = true }
        }
        .onChange(of: voice?.callee) { _, new in
            if focused != .callee { typed = new ?? "" }
        }
    }

    private func pinField(_ title: String, text: Binding<String>, field: PinField,
                          contentType: UITextContentType?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            SecureField(title, text: text)
                .keyboardType(.numberPad)
                .textContentType(contentType)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused, equals: field)
                .settingsInput(isFocused: focused == field)
                .accessibilityLabel(title)
                .accessibilityHint("Enter 4 to 12 digits")
        }
    }

    private func save() {
        problem = nil
        let callee = VoiceFormat.normalized(typed)
        saving = true
        focused = nil
        Task {
            problem = await model.changeVoice(.callee(callee))
            saving = false
            if problem != nil { typed = shownCallee }
        }
    }

    private func changePin() {
        pinNote = nil
        changingPin = true
        focused = nil
        Task {
            let failure = await model.changeVoice(.pin(current: currentPin, next: newPin))
            changingPin = false
            if let failure {
                pinNote = failure
            } else {
                pinNote = "Your pin is changed. It applies from the next call."
                currentPin = ""; newPin = ""; repeatPin = ""
            }
        }
    }

    private func test() {
        problem = nil
        testing = true
        Task {
            problem = await model.changeVoice(.test)
            testing = false
        }
    }
}
#endif
