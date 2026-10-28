#if os(iOS)
import SqueakCore
import SwiftUI

/// Settings › Phone calls: the extension Squeak rings when an agent is waiting on you, and a test call. The Mac
/// owns the setting (`voice` in the phone view) and only accepts an internal extension; a test touches no chat.
struct VoiceSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var loaded = false
    @State private var saving = false
    @State private var testing = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var voice: VoiceView? { model.snapshot?.voice }
    private var shownCallee: String { voice?.callee ?? "" }
    private var changed: Bool { VoiceFormat.normalized(typed) != voice?.callee }
    private var valid: Bool { VoiceFormat.normalized(typed).map(VoiceFormat.isExtension) ?? true }
    private var ringing: Bool { voice?.lastTest?.status == "ringing" }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering. Changes won't reach it.").font(.footnote).foregroundStyle(Theme.muted) }
            }
            if let voice, voice.isOn {
                Section {
                    HStack {
                        TextField(voice.defaultCallee ?? "101", text: $typed)
                            .keyboardType(.numberPad).focused($focused)
                            .font(.body.monospacedDigit())
                            .frame(minHeight: 44)
                            .accessibilityLabel("Extension to ring")
                        Button(saving ? "Saving…" : "Save", action: save)
                            .disabled(!changed || !valid || saving)
                            .frame(minHeight: 44)
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
            if !focused { typed = new ?? "" }
        }
    }

    private func save() {
        problem = nil
        let callee = VoiceFormat.normalized(typed)
        saving = true
        focused = false
        Task {
            problem = await model.changeVoice(.callee(callee))
            saving = false
            if problem != nil { typed = shownCallee }
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
