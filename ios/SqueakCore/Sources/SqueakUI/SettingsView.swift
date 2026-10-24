#if os(iOS)
import SqueakCore
import SwiftUI

/// Each stream this phone holds open, refreshed every second: whether it is
/// up, when it last heard anything, how often it dropped and roughly how much
/// it downloaded. What to look at when the phone seems behind the Mac.
struct ConnectionDetailsView: View {
    @Environment(AppModel.self) private var model
    @State private var streams: [StreamHealth] = []

    static func name(_ path: String) -> String {
        let parts = path.split(separator: "/")
        switch parts.dropFirst(2).first {
        case "state": return "Your Mac's view"
        case "results": return "Answers to commands"
        case "live": return "This chat's turn"
        default: return String(parts.last ?? "")
        }
    }

    static func size(_ bytes: Int) -> String {
        bytes < 1_000 ? "\(bytes) B" : bytes < 1_000_000 ? "\(bytes / 1_000) KB" : String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }

    var body: some View {
        Form {
            Section {
                let state = model.connection()
                LabeledContent("Status") { HStack(spacing: 7) { StatusDot(color: state.color); Text(state.text) } }
                if !model.demo { LabeledContent("Route", value: Connection.routeText(model.route)) }
                if let since = model.streamDownSince {
                    LabeledContent("Down since", value: Age.sync(since))
                }
            }
            if streams.isEmpty {
                Text("No streams open. Your Mac's channel may be the older one, which this phone polls every 2 seconds.")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            }
            ForEach(streams, id: \.path) { stream in
                Section(Self.name(stream.path)) {
                    LabeledContent("Connected", value: stream.connected ? stream.connectedAt.map { "Yes, since \(Age.sync($0))" } ?? "Yes" : "No, retrying")
                    LabeledContent("Last heard", value: stream.lastEventAt.map { Age.sync($0) } ?? "Not yet")
                    LabeledContent("Dropped", value: "\(stream.drops)×")
                    LabeledContent("Downloaded", value: Self.size(stream.bytes))
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Connection")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            while !Task.isCancelled {
                streams = await model.connectionDetails()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

/// A section header with its icon: small, muted, like every section in Settings.
private struct SettingsHeader: View {
    let title: String
    let icon: String
    init(_ title: String, icon: String) { self.title = title; self.icon = icon }
    var body: some View { Label(title, systemImage: icon) }
}

/// The gear: which Mac this phone is paired with, how it is doing, and unpairing.
struct SettingsView: View {
    /// A tab of the app's own bar, not a sheet: there is nothing to dismiss.
    var inTab = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.squeakScreen) private var screen
    @State private var confirmingUnpair = false
    /// `-squeak-controls` (screenshots only) opens the Mac controls page.
    @State private var showingControls = ProcessInfo.processInfo.arguments.contains("-squeak-controls")
    @State private var awakeProblem: String?
    @State private var lidActionsProblem: String?

    /// "64% · on battery · 35 W", "100% · plugged in".
    /// " · 37m ago" on a reading from a Mac that is not answering, nothing otherwise.
    static func lastKnown(_ mac: MacLiveness, now: Date = Date()) -> String {
        guard case .silent(let since) = mac else { return "" }
        return " · \(Age.sync(since, now: now))"
    }

    static func battery(percent: Int, power: PhoneSnapshot.MacPower) -> String {
        var parts = ["\(percent)%"]
        if let onBattery = power.onBattery { parts.append(onBattery ? "on battery" : "plugged in") }
        if let watts = power.watts { parts.append("\(watts) W") }
        return parts.joined(separator: " · ")
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    // MARK: The Mac card

    private var glance: (text: String, tint: Color)? {
        guard let snapshot = model.snapshot else { return nil }
        if case .silent = model.macLiveness() { return nil }
        var parts: [String] = []
        var tint = Theme.muted
        if let until = model.awake?.until { parts.append("Awake · \(AppModel.awakeLeft(until)) left") }
        else if model.awake != nil { parts.append("Awake") }
        if let onBattery = snapshot.macPower?.onBattery { parts.append(onBattery ? "On battery" : "Plugged in") }
        if snapshot.macPower?.lidClosed == true { parts.append("Lid closed") }
        switch snapshot.macHeat?.level {
        case "warm": parts.append("Running warm"); tint = Theme.needsYou
        case "hot": parts.append("Running hot"); tint = Theme.needsYou
        default: break
        }
        return parts.isEmpty ? nil : (parts.joined(separator: " · "), tint)
    }

    private var routePill: (text: String, color: Color) {
        if case .silent = model.macLiveness() { return ("Offline", Theme.offline) }
        guard model.snapshot != nil else { return ("Connecting", Theme.subtle) }
        return model.route == .local ? ("Wi-Fi direct", Theme.working) : ("Cloud", Theme.working)
    }

    private var macCard: some View {
        let pill = routePill
        return HStack(spacing: 14) {
            Image(systemName: "laptopcomputer").font(.title3).foregroundStyle(Theme.ink)
                .frame(width: 44, height: 44)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(model.snapshot?.mac ?? "Your Mac").font(.headline).lineLimit(1)
                    HStack(spacing: 5) {
                        StatusDot(color: pill.color)
                        Text(pill.text).font(.caption.weight(.medium))
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.surfaceRaised, in: Capsule())
                }
                if let glance {
                    Text(glance.text).font(.subheadline).foregroundStyle(glance.tint).lineLimit(2)
                } else if case .silent(let since) = model.macLiveness() {
                    Text("Last heard \(Age.sync(since))").font(.subheadline).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var macCardSection: some View {
        Section {
            TimelineView(.periodic(from: .now, by: 20)) { _ in
                if model.snapshot?.macControls != nil {
                    NavigationLink { MacControlsView() } label: { macCard }
                        .accessibilityIdentifier("mac-controls")
                        .accessibilityHint("Opens Mac controls")
                } else {
                    macCard
                }
            }
            if let snapshot = model.snapshot, snapshot.workspaces == nil {
                Text("New chats from this iPhone need a newer Squeak on your Mac. Update it and the button appears.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            DisclosureGroup {
                if let snapshot = model.snapshot {
                    let stale = Self.lastKnown(model.macLiveness())
                    if !model.demo { LabeledContent("Route", value: Connection.routeText(model.route)) }
                    if let power = snapshot.macPower {
                        if let percent = power.percent { LabeledContent("Battery", value: Self.battery(percent: percent, power: power) + stale) }
                        if let closed = power.lidClosed { LabeledContent("Lid", value: (closed ? "Closed" : "Open") + stale) }
                    }
                    if let reading = snapshot.macHeat?.reading { LabeledContent("Heat", value: reading + stale) }
                    LabeledContent("Last change", value: Age.describe(snapshot.generatedAt) == "now" ? "Just now" : "\(Age.describe(snapshot.generatedAt)) ago")
                    if model.awakeOffered {
                        Text(AwakeFormat.safetySentence(snapshot.awakeRules)).font(.footnote).foregroundStyle(Theme.muted)
                        if !model.awakeLidReady {
                            Text("To keep it awake with the lid closed, set that up once in Squeak on your Mac, under Settings, Keep awake.")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                    }
                }
                NavigationLink("Connection details") { ConnectionDetailsView() }
            } label: {
                Text("Details").font(.subheadline).foregroundStyle(Theme.muted)
            }
            .font(.subheadline)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            Form {
                macCardSection
                if model.awakeOffered {
                    AwakeSection(problem: $awakeProblem, lidProblem: $lidActionsProblem).id("settings-awake")
                }
                if let hotspot = model.snapshot?.hotspot {
                    HotspotSection(hotspot: hotspot)
                }
                Section {
                    Toggle("Show thinking live", isOn: Bindable(model).verbose)
                        .tint(Theme.primaryFill)
                        .frame(minHeight: 44)
                } header: { SettingsHeader("Live", icon: "bolt.horizontal") } footer: {
                    Text(model.liveAvailable
                        ? "A working chat's steps show its whole turn as it happens, thinking included. Your Mac sends it only while that chat is open here, and deletes it when you leave."
                        : "Needs your Mac on Squeak's faster channel. Until then, a working chat shows its latest six steps.")
                }
                Section {
                    if !model.hiddenHere.isEmpty {
                        Button("Show \(model.hiddenHere.count) hidden \(model.hiddenHere.count == 1 ? "chat" : "chats") again") { model.showHiddenAgain() }
                            .frame(minHeight: 44)
                    }
                    if let openReport = screen.openReport {
                        Button("Report a problem") {
                            // Close Settings first: the report sheet can't stack on this one.
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { openReport() }
                        }
                        .frame(minHeight: 44)
                    }
                    Button("Unpair this iPhone", role: .destructive) { confirmingUnpair = true }
                        .frame(minHeight: 44)
                } header: { SettingsHeader("This iPhone", icon: "iphone") } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Replies are signed on this iPhone and checked by your Mac. Face ID is asked before the first one, and again after Squeak has been away for five minutes.")
                        if !model.hiddenHere.isEmpty {
                            Text("Hiding only tidies this iPhone. A hidden chat comes back by itself when it has news.")
                        }
                        if !version.isEmpty { Text("Squeak for iPhone \(version)") }
                    }
                }
                // Room for the floating tab bar, so the last footer is never under it.
                Section { Color.clear.frame(height: 72).listRowBackground(Color.clear).id("settings-end") }
            }
            .onAppear {
                // Screenshots only: `-squeak-settings-scroll` shows the bottom of the page.
                if ProcessInfo.processInfo.arguments.contains("-squeak-settings-awake") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { proxy.scrollTo("settings-awake", anchor: .top) }
                }
                if ProcessInfo.processInfo.arguments.contains("-squeak-settings-scroll") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { proxy.scrollTo("settings-end", anchor: .bottom) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationDestination(isPresented: $showingControls) { MacControlsView() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if !inTab { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { model.unpair(); dismiss() }
            } message: {
                Text("It will stop seeing and answering your agents until you pair again.")
            }
            }
        }
        .foregroundStyle(Theme.ink)
    }
}
/// Hotspot failover: the Mac joins this iPhone's Personal Hotspot when its Wi-Fi drops while
/// something needs it, or now on a tap. iOS lets no app turn the hotspot on, so the footer says so.
private struct HotspotSection: View {
    @Environment(AppModel.self) private var model
    let hotspot: PhoneSnapshot.Hotspot
    @State private var editing = false
    @State private var setupOpen = false
    @State private var ssid = ""
    @State private var password = ""
    @State private var enabled = true
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        Section {
            if hotspot.configured, !editing {
                LabeledContent("Mac is on", value: hotspot.onHotspot ? "Your hotspot" : "Its usual Wi-Fi")
                LabeledContent("Hotspot", value: hotspot.ssid ?? "")
                Toggle("Switch if its Wi-Fi drops", isOn: Binding(get: { hotspot.enabled }, set: { on in
                    run(.configure(ssid: hotspot.ssid ?? "", password: nil, enabled: on))
                }))
                .tint(Theme.primaryFill).frame(minHeight: 44).disabled(busy)
                Button(hotspot.onHotspot ? "Back to Wi-Fi" : "Switch Mac to hotspot now") { run(hotspot.onHotspot ? .leave : .join) }
                    .frame(minHeight: 44).disabled(busy)
                Button("Change name or password") {
                    ssid = hotspot.ssid ?? ""; password = ""; enabled = hotspot.enabled; editing = true
                }
                .frame(minHeight: 44)
            } else {
                DisclosureGroup(hotspot.configured ? "Change name or password" : "Set up hotspot failover", isExpanded: Binding(get: { editing || setupOpen }, set: { if !editing { setupOpen = $0 } })) {
                TextField("Hotspot name", text: $ssid).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .frame(minHeight: 44)
                SecureField("Hotspot password", text: $password).frame(minHeight: 44)
                Toggle("Switch if its Wi-Fi drops", isOn: $enabled).tint(Theme.primaryFill).frame(minHeight: 44)
                Button(busy ? "Saving…" : "Save on your Mac") {
                    run(.configure(ssid: ssid.trimmingCharacters(in: .whitespaces), password: password, enabled: enabled)) { editing = false }
                }
                .frame(minHeight: 44)
                .disabled(busy || ssid.trimmingCharacters(in: .whitespaces).isEmpty || password.count < 8)
                if editing { Button("Cancel") { editing = false }.frame(minHeight: 44) }
                }
            }
        } header: { SettingsHeader("Hotspot failover", icon: "personalhotspot") } footer: {
            Text(problem ?? hotspot.last?.note ?? footer)
        }
    }

    private var footer: String {
        if hotspot.configured {
            return "During an awake session or while an agent works, a Mac that loses its internet for half a minute joins this hotspot. Turn Personal Hotspot on before you leave: iOS doesn't let apps turn it on."
        }
        return "Your hotspot's name and password are in Settings › Personal Hotspot. The password is kept only in your Mac's Keychain."
    }

    private func run(_ change: AppModel.HotspotChange, then: @escaping () -> Void = {}) {
        busy = true
        problem = nil
        Task {
            problem = await model.changeHotspot(change)
            busy = false
            if problem == nil { then() }
        }
    }
}

/// What the Mac does when its lid closes during a lid-closed session: four tiles, each a signed change
/// to the Mac's own setting. Shown only for a Mac that sends them. Nested inside Keep awake, under its card.
private struct LidActionsGroup: View {
    @Environment(AppModel.self) private var model
    @Binding var problem: String?
    /// True: one quiet row (title, what is on, chevron) that opens the tiles; false: the tiles alone, for
    /// inside another disclosure. Never persisted, so it is closed on every launch.
    var folded = true
    @State private var open = false

    private static let tiles: [String: (icon: String, name: String)] = [
        "displayOff": ("display", "Display off"),
        "mute": ("speaker.slash", "Mute"),
        "lowPower": ("battery.25percent", "Low Power"),
        "freezeApps": ("pause.circle", "Pause chat apps"),
    ]

    private static let short: [String: String] = ["displayOff": "Display off", "mute": "mute", "lowPower": "Low Power", "freezeApps": "pause chat apps"]

    private var summary: String {
        let on = AwakeFormat.lidActionInfos.filter { model.lidActions?[$0.key] ?? false }.map { Self.short[$0.key] ?? $0.title }
        return on.isEmpty ? "Nothing" : on.joined(separator: ", ")
    }

    var body: some View {
        if folded {
            VStack(alignment: .leading, spacing: 0) {
                Button { withAnimation(.easeInOut(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "laptopcomputer").font(.footnote).foregroundStyle(Theme.muted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("When the lid closes").font(.subheadline)
                            Text(summary).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                if open { tilesView.padding(.bottom, 4) }
            }
            .padding(.top, 2)
            .overlay(alignment: .top) { Divider() }
        } else {
            tilesView
        }
    }

    private var tilesView: some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(AwakeFormat.lidActionInfos) { info in
                    let on = model.lidActions?[info.key] ?? false
                    let tile = Self.tiles[info.key] ?? ("questionmark", info.title)
                    Button { Task { problem = await model.changeLidAction(info.key, !on) } } label: {
                        HStack(spacing: 8) {
                            ZStack {
                                Image(systemName: tile.icon).font(.body).opacity(model.lidActionPending(info.key) ? 0 : 1)
                                if model.lidActionPending(info.key) { ProgressView() }
                            }
                            .frame(width: 24)
                            Text(tile.name).font(.footnote.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(on ? Theme.primaryText : Theme.ink)
                        .background(on ? Theme.primaryFill : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(on ? Color.clear : Theme.line))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(info.title)
                    .accessibilityValue(on ? "On" : "Off")
                    .accessibilityHint(info.detail)
                    .accessibilityAddTraits(.isToggle)
                    .accessibilityIdentifier("lid-action-\(info.key)")
                }
            }
            Text(problem ?? "Only in a lid closed session. Undone when the lid opens.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

/// One mode's switches as plain toggles: what a session does with the lid open, or when it closes. Each is a signed
/// change to the Mac's own setting, kept per mode, so changing one mode never touches the other.
private struct AwakeModeSwitches: View {
    @Environment(AppModel.self) private var model
    let open: Bool
    @Binding var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(open ? AwakeFormat.openActionInfos : AwakeFormat.lidActionInfos) { info in
                let on = model.awakeSwitch(info.key, open: open)
                Toggle(isOn: Binding(get: { on }, set: { value in
                    Task { problem = await model.changeLidAction(info.key, value, open: open) }
                })) {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(info.title).font(.subheadline)
                            if model.lidActionPending(info.key, open: open) { ProgressView().controlSize(.mini) }
                        }
                        Text(info.detail).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(Theme.primaryFill)
                .frame(minHeight: 44)
                .padding(.vertical, 4)
                .accessibilityIdentifier("\(open ? "open" : "lid")-action-\(info.key)")
            }
            Text(problem ?? (open ? "While a session runs with the lid open. Undone when it ends."
                                  : "When the lid closes in a lid closed session. Undone when it opens."))
                .font(.footnote).foregroundStyle(Theme.muted).padding(.top, 2)
        }
    }
}

/// The Mac's awake session: what it is doing now, then a way to start one for a while, add time or end it.
/// Everything shown is what the Mac reports; the phone only words it.
private struct AwakeSection: View {
    @Environment(AppModel.self) private var model
    @Binding var problem: String?
    @Binding var lidProblem: String?
    @State private var confirmingEnd = false
    @State private var untilTime = Date().addingTimeInterval(3 * 3600)
    /// On unless you turn it off, and remembered: a Mac you set to stay awake should stay awake with its lid shut.
    /// Without the lid-closed setup on the Mac there is nothing to turn on, and the footer says so.
    @AppStorage("awakeWithLid") private var withLid = true

    private static let durations: [(String, String, Int)] = [("1h", "1 hour", 60), ("2h", "2 hours", 120), ("4h", "4 hours", 240), ("8h", "8 hours", 480)]

    @State private var chosenMinutes = 120
    @State private var peakMinutes = 60
    @State private var showingInfo = false

    var body: some View {
        Section {
            TimelineView(.periodic(from: .now, by: 15)) { _ in
                VStack(alignment: .leading, spacing: 14) {
                    // Mode first, then its switches, then starting it: with nothing running the tabs lead.
                    if model.awakeModesOffered && model.awake == nil {
                        modeTabs
                        AwakeModeSwitches(open: !shownLid, problem: $lidProblem)
                        Divider()
                    }
                    if let awake = model.awake { onCard(awake) } else { offCard }
                    if let problem = model.snapshot?.awakeSleepProblem {
                        HStack(alignment: .top, spacing: 10) {
                            StatusDot(color: Theme.error).padding(.top, 5)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Sleep is still turned off").font(.subheadline.weight(.medium))
                                Text(problem).font(.footnote).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    if model.awakeModesOffered && model.awake != nil {
                        modeTabs
                        AwakeModeSwitches(open: !shownLid, problem: $lidProblem)
                    } else if model.lidActionsOffered && model.awake != nil {
                        LidActionsGroup(problem: $lidProblem)
                    }
                }
                .padding(.vertical, 6)
            }
        } header: {
            HStack {
                SettingsHeader("Keep awake", icon: "moon.zzz")
                Spacer()
                Button { showingInfo = true } label: { Image(systemName: "info.circle") }
                    .accessibilityLabel("About keeping your Mac awake")
            }
        } footer: {
            Text(problem ?? "Stops your Mac sleeping so this iPhone can reach it.")
        }
        .alert("Keeping your Mac awake", isPresented: $showingInfo) {
            Button("OK", role: .cancel) {}
        } message: { Text(footer) }
    }

    @ViewBuilder
    private func onCard(_ awake: AppModel.AwakeStatus) -> some View {
        let left = awake.until.map { max(0, $0.timeIntervalSinceNow / 60) }
        HStack(spacing: 10) {
            if awake.pending { ProgressView() } else { StatusDot(color: Theme.working, pulses: true, period: 2) }
            VStack(alignment: .leading, spacing: 2) {
                Text(awake.pending ? "Starting…" : awake.until.map { "On until \($0.formatted(date: .omitted, time: .shortened))" } ?? "On until you end it")
                    .font(.title3.weight(.semibold))
                if let until = awake.until, !awake.pending {
                    Text("\(Self.left(until)) left").font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        if let left {
            ProgressView(value: min(1, left / Double(max(peakMinutes, Int(left.rounded(.up)), 1))))
                .tint(Theme.working)
                .onAppear { peakMinutes = max(peakMinutes, Int(left.rounded(.up))) }
                .onChange(of: awake.until) { _, new in
                    if let new { peakMinutes = max(Int((new.timeIntervalSinceNow / 60).rounded(.up)), 1) }
                }
        }
        if let lid = awake.lid { lidRow(lid, problem: awake.lidProblem) }
        if let safety = awake.safety {
            Label(safety, systemImage: "shield").font(.footnote).foregroundStyle(Theme.muted)
        }
        HStack(spacing: 10) {
            if awake.until != nil {
                pill("+1 hour", icon: "plus") { change(.extend(minutes: 60)) }
            }
            pill("End", icon: "stop.fill", destructive: true) { confirmingEnd = true }
        }
        .confirmationDialog("Let your Mac sleep again?", isPresented: $confirmingEnd, titleVisibility: .visible) {
            Button("End awake session", role: .destructive) { change(.end) }
        }
    }

    private func pill(_ title: String, icon: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) { Image(systemName: icon); Text(title) }.font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(destructive ? Theme.needsYou : Theme.ink)
                .background(Theme.surfaceRaised, in: Capsule())
                .overlay(Capsule().stroke(destructive ? Theme.needsYou.opacity(0.5) : Theme.line))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var offCard: some View {
        if let ended = AwakeFormat.ended(model.snapshot?.awakeLastEnd) {
            Text(ended).font(.footnote).foregroundStyle(Theme.muted)
        }
        HStack(spacing: 8) {
            ForEach(Self.durations, id: \.0) { choice in
                Button(choice.0) { chosenMinutes = choice.2 }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .foregroundStyle(chosenMinutes == choice.2 ? Theme.primaryText : Theme.ink)
                    .background(chosenMinutes == choice.2 ? Theme.primaryFill : Theme.surfaceRaised, in: Capsule())
                    .buttonStyle(.plain)
                    .accessibilityLabel(choice.1)
                    .accessibilityAddTraits(chosenMinutes == choice.2 ? .isSelected : [])
            }
        }
        Button { change(.start(minutes: chosenMinutes, lid: lid)) } label: {
            Label(model.awakeModesOffered ? (lid ? "Keep awake, lid closed" : "Keep awake, lid open") : "Keep Mac awake",
                  systemImage: "moon.zzz.fill").font(.headline)
                .frame(maxWidth: .infinity, minHeight: 50)
                .foregroundStyle(Theme.primaryText)
                .background(Theme.primaryFill, in: Capsule())
        }
        .buttonStyle(.plain)
        if model.awakeLidReady && !model.awakeModesOffered {
            Toggle(isOn: $withLid) { Label("With the lid closed", systemImage: "laptopcomputer") .font(.subheadline) }
                .tint(Theme.primaryFill)
        }
        DisclosureGroup {
            HStack(spacing: 12) {
                DatePicker("Until", selection: $untilTime, displayedComponents: .hourAndMinute)
                Button("Start") { change(.start(minutes: Self.minutes(until: untilTime), lid: lid)) }
                    .buttonStyle(.bordered).tint(Theme.primaryFill)
            }
            if !lid {
                Button("Until I end it") { change(.start(minutes: nil)) }.tint(Theme.primaryFill)
            }
            if model.lidActionsOffered && !model.awakeModesOffered {
                VStack(alignment: .leading, spacing: 6) {
                    Label("When the lid closes", systemImage: "laptopcomputer")
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                    LidActionsGroup(problem: $lidProblem, folded: false)
                }
            }
        } label: { Text("More options").font(.subheadline).foregroundStyle(Theme.muted) }
    }

    /// The lid-closed part of the session, as the Mac reports it: working on it, safe to close, or why not.
    @ViewBuilder
    private func lidRow(_ lid: String, problem: String?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            switch lid {
            case "on": StatusDot(color: Theme.working).padding(.top, 5)
            case "failed": StatusDot(color: Theme.error).padding(.top, 5)
            default: ProgressView()
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(lid == "on" ? "Lid closed is on" : lid == "starting" ? "Getting ready for a closed lid" : "Lid closed didn't turn on")
                    .font(.body)
                Text(lid == "on" ? "Safe to close the lid. Keep your Mac on a hard, open surface, never in a bag."
                     : lid == "starting" ? "Keep the lid open for a few seconds."
                     : ((problem.map { $0 + " " } ?? "") + "The session still runs with the lid open."))
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4).frame(minHeight: 44)
        .accessibilityElement(children: .combine)
    }

    private var lid: Bool { withLid && model.awakeLidReady }

    /// The tab on screen: the running session's mode while one runs, else the one the next start uses.
    private var shownLid: Bool {
        if let awake = model.awake { return awake.lid != nil }
        return withLid
    }

    /// Lid open | Lid closed. With nothing running it picks the next session's mode and shows that mode's
    /// switches; while one runs it switches the session itself, keeping its end (a lid-closed session needs one).
    private var modeTabs: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("Mode", selection: Binding(get: { shownLid }, set: { closed in
                withLid = closed
                guard let awake = model.awake, (awake.lid != nil) != closed else { return }
                let left = awake.until.map { max(1, Int(($0.timeIntervalSinceNow / 60).rounded(.up))) }
                if closed && !model.awakeLidReady { return }
                change(.start(minutes: left ?? (closed ? chosenMinutes : nil), lid: closed))
            })) {
                Label("Lid open", systemImage: "laptopcomputer").tag(false)
                Label("Lid closed", systemImage: "laptopcomputer.slash").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("awake-mode")
            if shownLid && !model.awakeLidReady {
                Text("Lid closed needs setting up once in Squeak on your Mac, under Settings, Keep awake. Its switches are saved for then.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .padding(.top, 4)
    }

    private var footer: String {
        let safety = AwakeFormat.safetySentence(model.snapshot?.awakeRules)
        if model.awakeLidReady {
            return "Stops your Mac sleeping, on battery too, so this iPhone can reach it. \(safety)"
        }
        return "Stops your Mac sleeping, on battery too, so this iPhone can reach it. To keep it awake with the lid closed, set that up once in Squeak on your Mac, under Settings, Keep awake. \(safety)"
    }

    private func change(_ change: AppModel.AwakeChange) {
        Task { problem = await model.changeAwake(change) }
    }

    /// Minutes until the next time the clock shows `date`'s hour and minute (tomorrow if passed today).
    static func minutes(until date: Date, now: Date = Date()) -> Int {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        let next = Calendar.current.nextDate(after: now, matching: parts, matchingPolicy: .nextTime) ?? now.addingTimeInterval(3600)
        return max(1, Int((next.timeIntervalSince(now) / 60).rounded()))
    }

    static func left(_ until: Date) -> String { AppModel.awakeLeft(until) }
}
#endif
