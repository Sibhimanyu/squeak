import SqueakCore
import SwiftUI

/// The words of the Mac controls page, kept apart so they can be tested on the Mac too.
enum MacControlsFormat {
    /// "Safari tabs", "Conductor chats", "Tabs".
    static func tabsTitle(_ tabs: FrontTabs?) -> String {
        guard let tabs, let app = tabs.app else { return "Tabs" }
        return tabs.kind == "conductor" ? "\(app.name) chats" : "\(app.name) tabs"
    }

    static let fanModes: [(mode: String, title: String)] = [("auto", "Auto"), ("40", "40%"), ("60", "60%"), ("80", "80%"), ("max", "Full")]

    /// "2,300 rpm" from the fastest fan, "Off" when stopped, nil when unread.
    static func fanSpeed(_ rpm: [Int]) -> String? {
        guard let fastest = rpm.max() else { return nil }
        return fastest == 0 ? "Off" : "\(fastest.formatted(.number.locale(Locale(identifier: "en_US")))) rpm"
    }

    /// Title for an energy mode.
    static func powerTitle(_ mode: String) -> String {
        switch mode { case "low": "Low Power"; case "high": "High Power"; default: "Automatic" }
    }

    /// The modes to offer, in order, only those this Mac lists.
    static func powerModes(_ power: PhoneSnapshot.MacControls.Power) -> [String] {
        ["auto", "low", "high"].filter { power.available.contains($0) }
    }

    /// One line under the picker: set-up first, then why the mode in use is not the pick.
    static func powerNote(_ power: PhoneSnapshot.MacControls.Power) -> String? {
        guard power.ready else { return "Set up on the Mac: Squeak › Settings › Keep awake." }
        if power.overridden == true { return "On Low Power while your Mac is warm or its battery is low. Your pick returns after." }
        return nil
    }

    /// Why the fans are not at what was picked, or nil when they are.
    static func fanNote(_ fans: PhoneSnapshot.MacControls.Fans) -> String? {
        guard fans.available else { return "Set up fan control on the Mac first: Squeak › Settings › Keep awake." }
        if fans.mode == "max", fans.choice != "max" { return "On full while your Mac is warm. They go back to your pick once it cools." }
        return nil
    }
}

#if os(iOS)
/// A Control Center-style page for the Mac: two big sliders, a grid of tiles, media keys only while sound plays,
/// the fans, and a short row of the apps that matter. The Mac decides what shows (`macControls`); this only draws.
struct MacControlsView: View {
    @Environment(AppModel.self) private var model
    @State private var problem: String?
    @State private var quitting: PhoneSnapshot.MacApp?
    @State private var confirmingLock = false
    @State private var showingApps = false
    @State private var frontTabs: FrontTabs?
    @State private var tabsProblem: String?
    @State private var tabsBusy = false

    private var controls: PhoneSnapshot.MacControls? { model.snapshot?.macControls }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if case .silent = model.macLiveness() {
                    Text("Your Mac isn't answering. Changes won't reach it.")
                        .font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                }
                if let controls {
                    if let volume = controls.volume {
                        ControlSlider(label: "Volume", symbol: controls.muted == true ? "speaker.slash.fill" : "speaker.wave.2.fill",
                                      reported: Double(volume),
                                      live: { model.changeControlLive(.volume($0)) },
                                      commit: { send(.volume($0)) })
                    }
                    if let brightness = controls.brightness {
                        ControlSlider(label: "Brightness", symbol: "sun.max.fill", reported: Double(brightness),
                                      live: { model.changeControlLive(.brightness($0)) },
                                      commit: { send(.brightness($0)) })
                    }
                    LazyVGrid(columns: columns, spacing: 10) {
                        if let muted = controls.muted {
                            Tile(title: "Mute", symbol: muted ? "speaker.slash.fill" : "speaker.fill", on: muted) { send(.muted(!muted)) }
                        }
                        if let held = controls.screenAwake {
                            Tile(title: "Screen on", symbol: "display", on: held) { send(.screenAwake(!held)) }
                        }
                        Tile(title: "Wake", symbol: "sun.max") { send(.wakeScreen) }
                        Tile(title: "Screen off", symbol: "moon.fill") { send(.displaySleep) }
                        Tile(title: "Lock", symbol: "lock.fill") { confirmingLock = true }
                        desktopsTile
                    }
                    // Right under the tiles: what you switch most, in whichever app is in front.
                    tabsCard
                    if controls.media?.playing == true { mediaCard }
                    if let fans = controls.fans { fansCard(fans) }
                    if let power = controls.power, !power.available.isEmpty { powerCard(power) }
                    appsCard(controls.apps ?? [])
                }
                if let problem {
                    Text(problem).font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
            .animation(.easeOut(duration: 0.2), value: controls?.media?.playing)
        }
        .background(Theme.bg.ignoresSafeArea())
        .confirmationDialog("Quit \(quitting?.name ?? "")?", isPresented: Binding(get: { quitting != nil }, set: { if !$0 { quitting = nil } }),
                            titleVisibility: .visible) {
            Button("Quit", role: .destructive) { if let app = quitting { send(.quit(app.id)) }; quitting = nil }
        } message: { Text("If it has unsaved work, it asks on the Mac before it quits.") }
        .confirmationDialog("Lock your Mac?", isPresented: $confirmingLock, titleVisibility: .visible) {
            Button("Lock", role: .destructive) { send(.lock) }
        } message: { Text("Its screen locks now. Your agents keep running.") }
        .sheet(isPresented: $showingApps) { NavigationStack { AppPickerView() }.presentationDetents([.large]) }
        .navigationTitle("Mac controls")
        .navigationBarTitleDisplayMode(.inline)
        // The tabs follow whichever app is in front: read again when that changes.
        .task(id: controls?.apps?.first(where: { $0.active == true })?.id ?? "") { await loadTabs() }
    }

    private func loadTabs(_ change: ControlsCommand.Change = .listTabs) async {
        tabsBusy = true
        let (answer, failure) = await model.frontTabs(change)
        if let answer { frontTabs = answer }
        tabsProblem = failure
        tabsBusy = false
    }

    private func send(_ change: ControlsCommand.Change) {
        Task { problem = await model.changeControl(change) }
    }

    // MARK: Tiles

    private var desktopsTile: some View {
        HStack(spacing: 0) {
            Button { send(.space("left")) } label: { Image(systemName: "chevron.left").frame(maxWidth: .infinity, maxHeight: .infinity) }
                .accessibilityLabel("Previous desktop")
            Rectangle().fill(Theme.line).frame(width: 1).padding(.top, 24).padding(.bottom, 12)
            Button { send(.space("right")) } label: { Image(systemName: "chevron.right").frame(maxWidth: .infinity, maxHeight: .infinity) }
                .accessibilityLabel("Next desktop")
        }
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(Theme.ink)
        .frame(height: 76)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .overlay(alignment: .top) {
            Text("Desktops").font(.caption2).foregroundStyle(Theme.muted).padding(.top, 8).allowsHitTesting(false)
        }
    }

    private var mediaCard: some View {
        HStack(spacing: 0) {
            mediaButton("backward.fill", "Previous track") { send(.media("previous")) }
            mediaButton("playpause.fill", "Play or pause", big: true) { send(.media("playPause")) }
            mediaButton("forward.fill", "Next track") { send(.media("next")) }
        }
        .frame(height: 64)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .transition(.opacity.combined(with: .scale(scale: 0.97)))
    }

    private func mediaButton(_ symbol: String, _ label: String, big: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: big ? 26 : 20, weight: .semibold))
                .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
        }
        .foregroundStyle(Theme.ink)
        .accessibilityLabel(label)
    }

    // MARK: Fans

    private func fansCard(_ fans: PhoneSnapshot.MacControls.Fans) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "fan.fill").foregroundStyle(Theme.muted)
                Text("Fans").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Spacer()
                if let speed = MacControlsFormat.fanSpeed(fans.rpm) { Text(speed).font(.footnote).foregroundStyle(Theme.subtle) }
            }
            .accessibilityElement(children: .combine)
            Picker("Fans", selection: Binding(get: { fans.choice }, set: { send(.fans($0)) })) {
                ForEach(MacControlsFormat.fanModes, id: \.mode) { Text($0.title).tag($0.mode) }
            }
            .pickerStyle(.segmented)
            .disabled(!fans.available)
            .accessibilityIdentifier("fan-mode")
            if let note = MacControlsFormat.fanNote(fans) {
                Text(note).font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    // MARK: Power

    private func powerCard(_ power: PhoneSnapshot.MacControls.Power) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill").foregroundStyle(Theme.muted)
                Text("Power").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Spacer()
                if let mode = power.mode, mode != (power.choice ?? mode) {
                    Text("Now \(MacControlsFormat.powerTitle(mode))").font(.footnote).foregroundStyle(Theme.subtle)
                }
            }
            .accessibilityElement(children: .combine)
            Picker("Power", selection: Binding(get: { power.choice ?? power.mode ?? "auto" }, set: { send(.power($0)) })) {
                ForEach(MacControlsFormat.powerModes(power), id: \.self) { Text(MacControlsFormat.powerTitle($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(!power.ready)
            .accessibilityIdentifier("power-mode")
            if let note = MacControlsFormat.powerNote(power) {
                Text(note).font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    // MARK: Apps

    private func appsCard(_ apps: [PhoneSnapshot.MacApp]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Apps").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            FlowLayout(spacing: 8) {
                ForEach(apps) { app in
                    Button { send(.open(app.id)) } label: {
                        HStack(spacing: 6) {
                            if app.active == true { Circle().fill(Theme.working).frame(width: 7, height: 7).accessibilityHidden(true) }
                            Text(app.name).font(.subheadline).lineLimit(1)
                        }
                        .foregroundStyle(Theme.ink)
                        .padding(.horizontal, 12).frame(minHeight: 44)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                    }
                    .contextMenu {
                        Button("Bring to front", systemImage: "macwindow") { send(.open(app.id)) }
                        Button("Quit", systemImage: "xmark.circle", role: .destructive) { quitting = app }
                    }
                    .accessibilityHint("Brings it to the front. Hold to quit it.")
                }
                Button { showingApps = true } label: {
                    Label("More apps", systemImage: "ellipsis")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 12).frame(minHeight: 44)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }
}

extension MacControlsView {
    // MARK: Tabs

    /// The front app's tabs: a browser's or Terminal's tab strip, or Conductor's workspaces and their open chats.
    var tabsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: frontTabs?.kind == "conductor" ? "rectangle.stack" : "square.on.square")
                    .foregroundStyle(Theme.muted)
                Text(MacControlsFormat.tabsTitle(frontTabs)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Spacer()
                Button { Task { await loadTabs() } } label: {
                    if tabsBusy { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
                }
                .foregroundStyle(Theme.muted).frame(minWidth: 44, minHeight: 32)
                .accessibilityLabel("Read the tabs again")
            }
            if let tabs = frontTabs?.tabs, !tabs.isEmpty {
                ForEach(tabs) { tab in
                    tabRow(tab.title, selected: tab.selected) { Task { await loadTabs(.selectTab(tab.index, title: tab.title)) } }
                }
            } else if let workspaces = frontTabs?.workspaces, !workspaces.isEmpty {
                ForEach(workspaces) { workspace in
                    Text(workspace.name).font(.caption).foregroundStyle(Theme.subtle).padding(.top, 4)
                    ForEach(workspace.chats) { chat in
                        tabRow(chat.title, working: chat.working) { Task { await loadTabs(.showChat(chat.id)) } }
                    }
                }
            } else if let note = frontTabs?.note {
                Text(note).font(.footnote).foregroundStyle(Theme.muted)
            } else if frontTabs == nil, tabsBusy {
                Text("Reading the front app's tabs…").font(.footnote).foregroundStyle(Theme.muted)
            }
            if let tabsProblem { Text(tabsProblem).font(.footnote).foregroundStyle(Theme.muted) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    private func tabRow(_ title: String, selected: Bool = false, working: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if working { Circle().fill(Theme.working).frame(width: 7, height: 7).accessibilityHidden(true) }
                Text(title).font(.subheadline).lineLimit(1).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                if selected { Image(systemName: "checkmark").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Theme.lineStrong : Theme.line))
            .contentShape(Rectangle())
        }
        .disabled(tabsBusy)
        .accessibilityLabel(working ? "\(title), working" : title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

extension DemoData {
    /// The demo Mac's front app, for screenshots: Safari with a few tabs.
    static var frontTabs: FrontTabs {
        let json = #"{"app":{"id":"com.apple.Safari","name":"Safari"},"kind":"tabs","tabs":[{"index":0,"title":"GitHub","selected":true},{"index":1,"title":"Squeak - Firebase console","selected":false},{"index":2,"title":"Claude Docs","selected":false},{"index":3,"title":"Heresay","selected":false}]}"#
        return try! JSONDecoder().decode(FrontTabs.self, from: Data(json.utf8))
    }
}

/// One toggle or action as a square-ish tile: icon over a short label, filled with the primary fill while on.
private struct Tile: View {
    let title: String
    let symbol: String
    var on = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                Text(title).font(.footnote.weight(.medium))
            }
            .foregroundStyle(on ? Theme.primaryText : Theme.ink)
            .frame(maxWidth: .infinity, minHeight: 76)
            .background(on ? Theme.primaryFill : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Color.clear : Theme.line))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(on ? "On" : "")
        .accessibilityAddTraits(.isButton)
    }
}

/// A rounded fill bar with its icon, like Control Center's. It moves with the finger at once (the value is local),
/// tells the Mac at most every 150 ms while dragging and once more on release, and ignores what the Mac reports
/// until the drag is over and 2 s have passed or the Mac has caught up, so a stale reading never snaps it back.
private struct ControlSlider: View {
    let label: String
    let symbol: String
    let reported: Double
    let live: (Int) -> Void
    let commit: (Int) -> Void
    @State private var local: Double?
    @State private var dragging = false
    @State private var release: Task<Void, Never>?
    @State private var lastLive = -1

    private var value: Double { local ?? reported }

    var body: some View {
        GeometryReader { proxy in
            let fraction = min(max(value / 100, 0), 1)
            ZStack(alignment: .leading) {
                Theme.surface
                Rectangle().fill(Theme.primaryFill)
                    .frame(width: proxy.size.width * fraction)
                    .animation(nil, value: value)
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(fraction > 0.14 ? Theme.primaryText : Theme.muted)
                    .padding(.leading, 20)
                    .accessibilityHidden(true)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: 16))
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { drag in
                    release?.cancel()
                    dragging = true
                    let next = min(max(drag.location.x / max(proxy.size.width, 1) * 100, 0), 100)
                    local = next.rounded()
                    let whole = Int(next.rounded())
                    if whole != lastLive { lastLive = whole; live(whole) }
                }
                .onEnded { _ in
                    dragging = false
                    lastLive = -1
                    commit(Int(value.rounded()))
                    release = Task {
                        try? await Task.sleep(for: .seconds(2))
                        if !Task.isCancelled { local = nil }
                    }
                })
        }
        .frame(height: 64)
        .onChange(of: reported) { _, new in
            if !dragging, let local, abs(new - local) <= 1 { self.local = nil }
        }
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue("\(Int(value.rounded())) percent")
        .accessibilityAdjustableAction { direction in
            let step: Double = direction == .increment ? 5 : -5
            let next = min(max(value + step, 0), 100)
            local = next
            commit(Int(next))
        }
    }
}

/// Chips that wrap onto as many lines as they need.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? 320, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(bounds.width, subviews)
        for (subview, origin) in zip(subviews, laid.origins) {
            subview.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + rowHeight), origins)
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
