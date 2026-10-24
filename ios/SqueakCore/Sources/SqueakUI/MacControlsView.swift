import SqueakCore
import SwiftUI

/// The words of the Mac controls page, kept apart so they can be tested on the Mac too.
enum MacControlsFormat {
    static let fanModes: [(mode: String, title: String)] = [("auto", "Auto"), ("40", "40%"), ("60", "60%"), ("80", "80%"), ("max", "Full")]

    /// "2,300 rpm" from the fastest fan, "Off" when stopped, nil when unread.
    static func fanSpeed(_ rpm: [Int]) -> String? {
        guard let fastest = rpm.max() else { return nil }
        return fastest == 0 ? "Off" : "\(fastest.formatted(.number.locale(Locale(identifier: "en_US")))) rpm"
    }

    /// Why the fans are not at what was picked, or nil when they are.
    static func fanNote(_ fans: PhoneSnapshot.MacControls.Fans) -> String? {
        guard fans.available else { return "Set up fan control on the Mac first: Squeak › Settings › Keep awake." }
        if fans.mode == "max", fans.choice != "max" { return "On full while your Mac is warm. They go back to your pick once it cools." }
        return nil
    }
}

#if os(iOS)
/// Live controls for the Mac: volume, brightness, fans, screen off. Each change is one signed command; the
/// page shows what the Mac reports, with this phone's last change laid over it until the Mac confirms.
struct MacControlsView: View {
    @Environment(AppModel.self) private var model
    @State private var volume: Double?
    @State private var brightness: Double?
    @State private var problem: String?
    @State private var busy = false

    private var controls: PhoneSnapshot.MacControls? { model.snapshot?.macControls }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering, so these are its last readings and changes won't reach it.").foregroundStyle(Theme.muted) }
            }
            if let controls {
                soundSection(controls)
                displaySection(controls)
                if let fans = controls.fans { fanSection(fans) }
            }
            if let problem {
                Section { Text(problem).foregroundStyle(Theme.muted) }
            }
        }
        .navigationTitle("Mac controls")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send(_ change: ControlsCommand.Change) {
        busy = true
        Task {
            problem = await model.changeControl(change)
            busy = false
            volume = nil
            brightness = nil
        }
    }

    // MARK: Sound

    private func soundSection(_ controls: PhoneSnapshot.MacControls) -> some View {
        Section {
            if let current = controls.volume {
                HStack(spacing: 12) {
                    Image(systemName: "speaker.fill").foregroundStyle(Theme.muted).accessibilityHidden(true)
                    Slider(value: Binding(get: { volume ?? Double(current) }, set: { volume = $0 }), in: 0...100, step: 1) { editing in
                        if !editing, let volume { send(.volume(Int(volume))) }
                    }
                    .tint(Theme.primaryFill)
                    .accessibilityLabel("Volume")
                    Image(systemName: "speaker.wave.3.fill").foregroundStyle(Theme.muted).accessibilityHidden(true)
                }
                .frame(minHeight: 44)
            }
            if let muted = controls.muted {
                Toggle("Mute", isOn: Binding(get: { muted }, set: { send(.muted($0)) }))
                    .tint(Theme.primaryFill)
                    .frame(minHeight: 44)
            }
        } header: { Text("Sound") }
    }

    // MARK: Display

    private func displaySection(_ controls: PhoneSnapshot.MacControls) -> some View {
        Section {
            if let current = controls.brightness {
                HStack(spacing: 12) {
                    Image(systemName: "sun.min").foregroundStyle(Theme.muted).accessibilityHidden(true)
                    Slider(value: Binding(get: { brightness ?? Double(current) }, set: { brightness = $0 }), in: 0...100, step: 1) { editing in
                        if !editing, let brightness { send(.brightness(Int(brightness))) }
                    }
                    .tint(Theme.primaryFill)
                    .accessibilityLabel("Brightness")
                    Image(systemName: "sun.max.fill").foregroundStyle(Theme.muted).accessibilityHidden(true)
                }
                .frame(minHeight: 44)
            }
            Button("Turn the screen off") { send(.displaySleep) }
                .frame(minHeight: 44)
                .disabled(busy)
        } header: { Text("Display") } footer: {
            Text(controls.brightness == nil
                 ? "Brightness shows while the Mac's lid is open."
                 : "The built-in display. Any key or the trackpad wakes the screen.")
        }
    }

    // MARK: Fans

    private func fanSection(_ fans: PhoneSnapshot.MacControls.Fans) -> some View {
        Section {
            Picker("Fans", selection: Binding(get: { fans.choice }, set: { send(.fans($0)) })) {
                ForEach(MacControlsFormat.fanModes, id: \.mode) { Text($0.title).tag($0.mode) }
            }
            .pickerStyle(.segmented)
            .disabled(!fans.available || busy)
            .frame(minHeight: 44)
            .accessibilityIdentifier("fan-mode")
            if let speed = MacControlsFormat.fanSpeed(fans.rpm) {
                LabeledContent("Speed now", value: speed)
            }
        } header: { Text("Fans") } footer: {
            Text(MacControlsFormat.fanNote(fans)
                 ?? "Auto is macOS's own control. A speed you pick holds until you change it or Squeak stops; if the Mac warms up during an awake session, the fans go to full.")
        }
    }
}
#endif
