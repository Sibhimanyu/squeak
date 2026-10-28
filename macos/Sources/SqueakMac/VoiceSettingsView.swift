import SqueakMacCore
import SwiftUI

/// Settings › Phone calls: which extension Squeak rings when an agent is waiting on you. The PBX details live
/// where the call is placed (the Home Assistant add-on, or this Mac's config); only this one changes day to day.
struct VoiceSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var typed = ""
    @State private var loaded = false

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
}
