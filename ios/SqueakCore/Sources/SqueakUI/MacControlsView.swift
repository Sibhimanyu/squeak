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
    @State private var quitting: PhoneSnapshot.MacApp?
    @State private var confirmingLock = false

    private var controls: PhoneSnapshot.MacControls? { model.snapshot?.macControls }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering, so these are its last readings and changes won't reach it.").foregroundStyle(Theme.muted) }
            }
            if let controls {
                soundSection(controls)
                displaySection(controls)
                if let apps = controls.apps { appsSection(apps) }
                keysSection
                if let fans = controls.fans { fanSection(fans) }
            }
            if let problem {
                Section { Text(problem).foregroundStyle(Theme.muted) }
            }
            Section {
                LabeledContent("Connection", value: model.controlsLive ? "Same Wi-Fi · live" : "Through the cloud")
            } footer: {
                Text(model.controlsLive
                     ? "On the same Wi-Fi, sliders move your Mac as you drag, and changes on the Mac show here within a few seconds."
                     : "Through the cloud a change goes when you let go. On the same Wi-Fi as your Mac, the controls are live.")
            }
        }
        .confirmationDialog("Quit \(quitting?.name ?? "")?", isPresented: Binding(get: { quitting != nil }, set: { if !$0 { quitting = nil } }),
                            titleVisibility: .visible) {
            Button("Quit", role: .destructive) { if let app = quitting { send(.quit(app.id)) }; quitting = nil }
        } message: { Text("If it has unsaved work, it asks on the Mac before it quits.") }
        .confirmationDialog("Lock your Mac?", isPresented: $confirmingLock, titleVisibility: .visible) {
            Button("Lock", role: .destructive) { send(.lock) }
        } message: { Text("Its screen locks now. Your agents keep running.") }
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
                    Slider(value: Binding(get: { volume ?? Double(current) }, set: { volume = $0; model.changeControlLive(.volume(Int($0))) }), in: 0...100, step: 1) { editing in
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
                    Slider(value: Binding(get: { brightness ?? Double(current) }, set: { brightness = $0; model.changeControlLive(.brightness(Int($0))) }), in: 0...100, step: 1) { editing in
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

    // MARK: Apps

    private func appsSection(_ apps: [PhoneSnapshot.MacApp]) -> some View {
        Section {
            ForEach(apps) { app in
                Button { send(.open(app.id)) } label: {
                    HStack {
                        Text(app.name).foregroundStyle(Theme.ink)
                        Spacer(minLength: 8)
                        if app.active == true { Text("In front").font(.footnote).foregroundStyle(Theme.muted) }
                    }
                }
                .frame(minHeight: 44)
                .swipeActions { Button("Quit", role: .destructive) { quitting = app } }
                .contextMenu {
                    Button("Bring to front", systemImage: "macwindow") { send(.open(app.id)) }
                    Button("Quit", systemImage: "xmark.circle", role: .destructive) { quitting = app }
                }
                .accessibilityHint("Brings it to the front. Swipe or hold to quit it.")
            }
            NavigationLink { AppPickerView() } label: { Label("Open an app", systemImage: "plus.app") }
                .frame(minHeight: 44)
        } header: { Text("Apps") } footer: {
            Text("Tap an app to bring it to the front, swipe to quit it.")
        }
    }

    // MARK: Desktop, media, lock

    private var keysSection: some View {
        Section {
            HStack(spacing: 12) {
                Button { send(.space("left")) } label: { Label("Previous", systemImage: "chevron.left").frame(maxWidth: .infinity, minHeight: 44) }
                Button { send(.space("right")) } label: { Label("Next", systemImage: "chevron.right").frame(maxWidth: .infinity, minHeight: 44) }
            }
            .buttonStyle(.borderless)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Desktop")
            HStack(spacing: 12) {
                Button { send(.media("previous")) } label: { Image(systemName: "backward.fill").frame(maxWidth: .infinity, minHeight: 44) }
                    .accessibilityLabel("Previous track")
                Button { send(.media("playPause")) } label: { Image(systemName: "playpause.fill").frame(maxWidth: .infinity, minHeight: 44) }
                    .accessibilityLabel("Play or pause")
                Button { send(.media("next")) } label: { Image(systemName: "forward.fill").frame(maxWidth: .infinity, minHeight: 44) }
                    .accessibilityLabel("Next track")
            }
            .buttonStyle(.borderless)
            Button("Lock your Mac", role: .destructive) { confirmingLock = true }
                .frame(minHeight: 44)
        } header: { Text("Desktop and media") } footer: {
            Text("Previous and Next move between your Mac's desktops (Control-arrow, on unless you turned it off in Keyboard Shortcuts). Media keys play, pause and skip in whatever is playing.")
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
/// Every app on the Mac, asked for when this opens (6 KB is too much to carry in every view), searchable.
struct AppPickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var apps: [PhoneSnapshot.MacApp] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var search = ""

    private var shown: [PhoneSnapshot.MacApp] {
        search.isEmpty ? apps : apps.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        List {
            if loading {
                HStack(spacing: 8) { ProgressView(); Text("Asking your Mac…").foregroundStyle(Theme.muted) }
            } else if let problem {
                Text(problem).foregroundStyle(Theme.muted)
            }
            ForEach(shown) { app in
                Button(app.name) {
                    Task {
                        problem = await model.changeControl(.open(app.id))
                        if problem == nil { dismiss() }
                    }
                }
                .foregroundStyle(Theme.ink)
                .frame(minHeight: 44)
            }
        }
        .searchable(text: $search, prompt: "Find an app")
        .navigationTitle("Open an app")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let (list, failure) = await model.installedApps()
            apps = list
            problem = failure
            loading = false
        }
    }
}
#endif
