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
    private enum Field: Hashable { case callee }
    @FocusState private var focused: Field?

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
                // The pin lives with the placer of the call (the add-on, or this Mac); the Mac never shows it.
                PinSection(voice: voice)
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

    private func test() {
        problem = nil
        testing = true
        Task {
            problem = await model.changeVoice(.test)
            testing = false
        }
    }
}

/// Settings › Phone calls › Pin. Driven by `voice.pin` ("set", "off", "none", "unknown"); a Mac that omits it gets
/// today's page: the gateway's change-pin form and nothing else. A forgotten pin is reset by proving you own this
/// phone (Face ID or passcode, always, whatever "Ask for Face ID to send" says), never by knowing the old one.
private struct PinSection: View {
    @Environment(AppModel.self) private var model
    let voice: VoiceView

    private enum Form_: Hashable { case change, disable, enable, forgot }
    private enum Field: Hashable { case current, new, repeatPin }
    @State private var open: Form_?
    @State private var current = ""
    @State private var new = ""
    @State private var again = ""
    @State private var busy = false
    @State private var note: String?
    /// Set once the owner check passed for a reset; the new pin (or off) is then chosen.
    @State private var verified = false
    @State private var confirmingOff = false
    @FocusState private var focused: Field?

    private var state: String? { voice.pin }
    private var legacy: Bool { state == nil }
    private var newReady: Bool { VoiceFormat.isPin(new) && new == again }

    var body: some View {
        if legacy && voice.mode != "gateway" {
            EmptyView()
        } else {
            Section {
                VStack(alignment: .leading, spacing: 16) {
                    statusCard
                    content
                }
                .padding(.vertical, 8)
                if let note { Text(note).font(.footnote).foregroundStyle(Theme.muted) }
            } header: { Text("CALLING PIN") }
            .confirmationDialog("Turn the PIN off?", isPresented: $confirmingOff, titleVisibility: .visible) {
                Button("Turn PIN off", role: .destructive) { turnOffTapped() }
                Button("Keep the PIN", role: .cancel) {}
            } message: {
                Text("Anyone who answers the call will then be able to reply by key.")
            }
        }
    }

    private var statusCard: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: state == "off" ? "lock.open.fill" : "lock.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(state == "off" ? Theme.muted : Theme.primaryText)
                .frame(width: 42, height: 42)
                .background(state == "off" ? Theme.line : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(statusTitle).font(.headline)
                    Circle().fill(statusTint).frame(width: 7, height: 7).accessibilityHidden(true)
                }
                Text(statusDetail).font(.subheadline).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.line, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var statusTitle: String {
        switch state {
        case "set": return "Calling PIN is set"
        case "off": return "PIN protection is off"
        case "none": return "No PIN set"
        case "unknown": return "Checking PIN status"
        default: return "Calling PIN"
        }
    }

    private var statusDetail: String {
        switch state {
        case "set": return "Your 4 to 12 digit PIN is ready. The call settings on your Mac decide when it is requested."
        case "off": return "Anyone who answers a call can reply by key. Turn protection on whenever you like."
        case "none": return "Set a 4 to 12 digit PIN to let callers reply by key."
        case "unknown": return "Waiting for your add-on to report PIN status. Update Squeak Voice to 0.5.0 or newer if this persists."
        default: return "Your PIN is kept with the service that places your calls."
        }
    }

    private var statusTint: Color {
        switch state {
        case "set": return Theme.working
        case "off": return Theme.muted
        case "unknown": return Theme.done
        default: return Theme.needsYou
        }
    }

    @ViewBuilder private var content: some View {
        switch state {
        case nil:
            form(.change, title: "Change PIN", needsCurrent: true, button: "Change PIN")
        case "set":
            if verified {
                forgot
            } else if open == .change {
                form(.change, title: "Change PIN", needsCurrent: true, button: "Save new PIN")
            } else {
                actionRow("Change PIN", detail: "Choose a new calling PIN", icon: "arrow.triangle.2.circlepath") {
                    closeAll(); open = .change; note = nil
                }
                .disabled(busy)
                actionRow("Turn PIN off", detail: "Allow replies without a PIN", icon: "lock.open", destructive: true) {
                    confirmingOff = true
                }
                .disabled(busy)
                actionRow("Forgot your PIN?", detail: "Verify it’s you to reset protection", icon: "questionmark.circle") { forgotTapped() }
                    .disabled(busy)
            }
        case "off":
            form(.enable, title: "Turn PIN on", needsCurrent: false, button: "Turn PIN on")
        case "none":
            form(.enable, title: "Set a PIN", needsCurrent: false, button: "Set a PIN")
        default:
            if verified {
                forgot
            } else {
                actionRow("Forgot your PIN?", detail: "Verify it’s you to reset protection", icon: "questionmark.circle") { forgotTapped() }
                    .disabled(busy)
            }
        }
    }

    private var forgot: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Reset calling PIN").font(.headline)
            Text("Choose a new PIN, or turn the requirement off.").font(.subheadline).foregroundStyle(Theme.muted)
            field("New PIN", text: $new, focus: .new, type: .newPassword)
            field("Repeat new PIN", text: $again, focus: .repeatPin, type: .newPassword)
            Button(busy ? "Saving…" : "Save new PIN") { run(.reset(next: new)) }
                .disabled(!newReady || busy).buttonStyle(PrimaryButtonStyle())
            Button("Turn PIN off instead", role: .destructive) { run(.reset(next: nil)) }
                .disabled(busy).frame(minHeight: 44)
            Button("Cancel") { closeAll() }.frame(minHeight: 44)
        }
        .padding(16)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }

    private func actionRow(_ title: String, detail: String, icon: String, destructive: Bool = false,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 13) {
                Image(systemName: icon).font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(destructive ? Theme.needsYou : Theme.muted)
                    .frame(width: 38, height: 38)
                    .background(Theme.bg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(destructive ? Theme.needsYou : Theme.ink)
                    Text(detail).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(Theme.subtle)
            }
            .padding(12)
            .contentShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .frame(minHeight: 60)
    }

    @ViewBuilder
    private func form(_ kind: Form_, title: String, needsCurrent: Bool, button: String, destructive: Bool = false,
                      warning: String? = nil) -> some View {
        if open == kind {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    Button("Cancel") { closeAll() }.font(.subheadline.weight(.medium)).frame(minHeight: 44)
                }
                if let warning { Text(warning).font(.footnote).foregroundStyle(Theme.muted) }
                if needsCurrent { field("Current PIN", text: $current, focus: .current, type: .password) }
                if kind != .disable {
                    field("New PIN", text: $new, focus: .new, type: .newPassword)
                    field("Repeat new PIN", text: $again, focus: .repeatPin, type: .newPassword)
                }
                Button(busy ? "Working…" : button, role: destructive ? .destructive : nil) { submit(kind) }
                    .disabled(!ready(kind) || busy)
                    .buttonStyle(PrimaryButtonStyle())
            }
            .padding(16)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(Theme.line, lineWidth: 1))
        } else {
            actionRow(title, detail: needsCurrent ? "Enter your current PIN and choose a new one" : "Choose a 4 to 12 digit calling PIN", icon: "arrow.triangle.2.circlepath") {
                closeAll(); open = kind; note = nil
            }
            .disabled(busy)
        }
    }

    private func ready(_ kind: Form_) -> Bool {
        switch kind {
        case .change: return VoiceFormat.isPin(current) && newReady && new != current
        case .disable: return VoiceFormat.isPin(current)
        case .enable: return newReady
        case .forgot: return newReady
        }
    }

    private func field(_ title: String, text: Binding<String>, focus: Field, type: UITextContentType?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            SecureField(title, text: text)
                .keyboardType(.numberPad)
                .textContentType(type)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused, equals: focus)
                .settingsInput(isFocused: focused == focus)
                .accessibilityLabel(title)
                .accessibilityHint("Enter 4 to 12 digits")
        }
    }

    private func closeAll() {
        open = nil; verified = false
        current = ""; new = ""; again = ""
        focused = nil
    }

    private func submit(_ kind: Form_) {
        switch kind {
        case .change:
            // An older Mac only knows the plain change; a newer one takes the action form.
            run(legacy ? nil : .change(current: current, next: new), legacy: .pin(current: current, next: new))
        case .disable: run(.disable(current: current))
        case .enable: run(.enable(next: new))
        case .forgot: break
        }
    }

    private func turnOffTapped() {
        note = nil
        busy = true
        Task {
            let ok = await model.confirmOwner(reason: "Turn off your calling PIN")
            busy = false
            if ok { run(.reset(next: nil)) } else { note = "Face ID was cancelled. Your PIN is unchanged." }
        }
    }

    /// Always Face ID or the passcode, even when sends no longer ask for it.
    private func forgotTapped() {
        note = nil
        busy = true
        Task {
            let ok = await model.confirmOwner(reason: "Reset your calling PIN")
            busy = false
            if ok { closeAll(); verified = true } else { note = "Face ID was cancelled. Your PIN is unchanged." }
        }
    }

    private func run(_ action: PinAction?, legacy change: VoiceChange? = nil) {
        guard let voiceChange = action.map(VoiceChange.pinAction) ?? change else { return }
        note = nil
        busy = true
        focused = nil
        Task {
            let failure = await model.changeVoice(voiceChange)
            busy = false
            if let failure {
                note = failure
            } else {
                note = Self.done(action)
                closeAll()
            }
        }
    }

    private static func done(_ action: PinAction?) -> String {
        switch action {
        case .disable?: return "The PIN is off. Calls can be answered by key without one."
        case .enable?: return "The PIN is on. It applies from the next call."
        case .reset(let next)?: return next == nil ? "The PIN is off." : "Your new PIN is set. It applies from the next call."
        default: return "Your pin is changed. It applies from the next call."
        }
    }
}
#endif
