import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Keep Mac awake, drawn from what the daemon reports (`/state`): whether it is on, when it ends, whether
/// the lid is safe to close, and why not when it is not. The views only word and lay that out; the
/// daemon decides every state, so the phone and Telegram agree with it.

/// The lengths offered, in minutes. A lid-closed session must end, so "until I end it" is not one of its choices.
enum AwakeChoice {
    static let lengths: [(minutes: Int, title: String)] = [(60, "1 hour"), (120, "2 hours"), (240, "4 hours"), (480, "8 hours")]
}

private struct AwakeDot: View {
    let color: Color
    var body: some View { Circle().fill(color).frame(width: 9, height: 9).accessibilityHidden(true) }
}

/// The live state, as lines: the headline with what is left, the lid, a safety rule acting, how the last
/// session ended. Shared by the menu-bar panel and Settings.
struct AwakeStatusLines: View {
    @Environment(AppModel.self) private var model
    var title = "Keep Mac awake"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                AwakeDot(color: model.awake == nil ? Theme.idle : Theme.working).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(Typo.label).foregroundStyle(Theme.ink)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(status(at: context.date)).font(Typo.body).foregroundStyle(Theme.muted).monospacedDigit()
                    }
                }
                Spacer(minLength: 0)
            }
            if let awake = model.awake {
                let lid = AwakeFormat.lid(awake)
                detailRow(lidColor(lid), AwakeFormat.lidTitle(lid), AwakeFormat.lidDetail(lid), working: lid == .starting)
                if let safety = awake.safety {
                    detailRow(Theme.idle, safety, nil)
                }
            } else if let ended = AwakeFormat.ended(model.awakeLastEnd) {
                Text(ended).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func status(at date: Date) -> String {
        guard let awake = model.awake else { return "Off. Your Mac sleeps as usual." }
        let head = AwakeFormat.headline(awake)
        guard let left = AwakeFormat.left(until: awake.until, now: date) else { return head }
        return "\(head) · \(left)"
    }

    private func lidColor(_ lid: AwakeFormat.Lid) -> Color {
        switch lid {
        case .on: Theme.working
        case .failed: Theme.error
        case .open, .starting: Theme.idle
        }
    }

    private func detailRow(_ color: Color, _ title: String, _ detail: String?, working: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group { if working { ProgressView().controlSize(.mini) } else { AwakeDot(color: color) } }
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Typo.body).foregroundStyle(Theme.ink)
                if let detail { Text(detail).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The menu-bar panel's awake row: pinned above the footer, so the state is visible without scrolling.
struct AwakeRow: View {
    @Environment(AppModel.self) private var model
    @AppStorage("awakeWithLid") private var withLid = true

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .top, spacing: Space.s) {
                AwakeStatusLines()
                if model.awake == nil { startMenu }
            }
            if let awake = model.awake {
                HStack(spacing: Space.s) {
                    if awake.until != nil {
                        Button("Add 1 hour") { Task { await model.changeAwake("extend", minutes: 60) } }
                            .buttonStyle(SecondaryButtonStyle())
                    }
                    if !awake.lid, model.awakeLidReady, let minutes = AwakeRow.minutesLeft(awake.until) {
                        Button("Add lid closed") { Task { await model.changeAwake("start", minutes: minutes, lid: true) } }
                            .buttonStyle(SecondaryButtonStyle())
                            .help("Keep awake with the lid closed too, for the time left")
                    }
                    Button("End") { Task { await model.changeAwake("end") } }
                        .buttonStyle(SecondaryButtonStyle())
                        .accessibilityLabel("End keep awake")
                    Spacer(minLength: 0)
                }
                .padding(.leading, 17)
            }
            if model.settingUpLid {
                Text("Waiting for your Mac password…").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if let problem = model.awakeSleepProblem {
                Text(problem).font(Typo.meta).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
            }
            if let note = model.awakeNote {
                Text(note).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let hotspot = model.hotspot, hotspot.onHotspot {
                Text("On your iPhone's hotspot\(hotspot.ssid.map { " (\($0))" } ?? "")").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Button { model.openSettings(.awake) } label: {
                Text("Awake settings…").font(Typo.meta)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
            .padding(.leading, 17)
        }
        .padding(.horizontal, PopoverMetrics.inset)
        .padding(.vertical, Space.m)
        .accessibilityElement(children: .contain)
    }

    private var startMenu: some View {
        Menu {
            let lid = withLid && model.awakeLidReady
            ForEach(AwakeChoice.lengths, id: \.minutes) { choice in
                Button(choice.title) { Task { await model.changeAwake("start", minutes: choice.minutes, lid: lid) } }
            }
            Button("Until I end it") { Task { await model.changeAwake("start") } }
                .disabled(lid)
            Divider()
            if model.awakeLidReady {
                Toggle("With the lid closed", isOn: $withLid)
            } else {
                Button("Set up lid closed…") { Task { await model.setUpLidClosed() } }
                    .disabled(model.settingUpLid)
            }
        } label: { Text("Start") }
        .menuStyle(.button).buttonStyle(SecondaryButtonStyle()).fixedSize()
        .accessibilityLabel("Start keeping this Mac awake")
    }

    static func minutesLeft(_ until: Date?, now: Date = Date()) -> Int? {
        guard let until else { return nil }
        return max(5, Int((until.timeIntervalSince(now) / 60).rounded()))
    }
}

/// Settings, Keep awake: the state and the start choices first; then lid closed and its one-time setup,
/// what the lid does, the safety rules, and hotspot failover.
struct AwakeSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage("awakeWithLid") private var withLid = true
    @AppStorage("awakeMinutes") private var minutes = 120
    @State private var hotspotName = ""
    @State private var hotspotPassword = ""
    /// The walk-through's short version: the state, the lid and energy mode only.
    var short = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if !model.awakeOffered {
                SettingsCard(title: "Keep awake session", subtitle: "Keep your Mac reachable for as long as you need.", symbol: "moon") {
                    Text("This version of the Squeak service can't keep your Mac awake. Update it and this page fills in.")
                        .foregroundStyle(.secondary)
                }
            } else {
                stateSection
                if !short, model.awakeOpenActions != nil { modeSection }
                lidSection
                if !short, model.awakeOpenActions == nil { actionsSection }
                if !short { safetySection; heatSection }
                powerSection
                if !short { hotspotSection }
            }
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await model.readAwake() }
    }

    private var lidOn: Bool { withLid && model.awakeLidReady }

    // MARK: State and start

    private var stateSection: some View {
        SettingsCard(title: "Keep awake session", subtitle: "Keep your Mac reachable for as long as you need.", symbol: "moon") {
            AwakeStatusLines(title: "Keep Mac awake")
            if let awake = model.awake {
                HStack(spacing: Space.s) {
                    if awake.until != nil {
                        Button("Add 1 hour") { Task { await model.changeAwake("extend", minutes: 60) } }.buttonStyle(SecondaryButtonStyle())
                    }
                    if !awake.lid, model.awakeLidReady, let left = AwakeRow.minutesLeft(awake.until) {
                        Button("Add lid closed") { Task { await model.changeAwake("start", minutes: left, lid: true) } }.buttonStyle(SecondaryButtonStyle())
                    }
                    Button("End session") { Task { await model.changeAwake("end") } }.buttonStyle(SecondaryButtonStyle())
                    Spacer(minLength: 0)
                }
            } else {
                Picker("For", selection: Binding(
                    get: { lidOn && minutes == 0 ? 120 : minutes }, set: { minutes = $0 })
                ) {
                    ForEach(AwakeChoice.lengths, id: \.minutes) { Text($0.title).tag($0.minutes) }
                    if !lidOn { Text("Until I end it").tag(0) }
                }
                if model.awakeLidReady && model.awakeOpenActions == nil {
                    Toggle(isOn: $withLid) {
                        Text("With the lid closed").frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                HStack {
                    Spacer(minLength: 0)
                    Button(model.awakeOpenActions == nil ? "Keep Mac awake" : lidOn ? "Keep awake, lid closed" : "Keep awake, lid open") {
                        let value = lidOn && minutes == 0 ? 120 : minutes
                        Task { await model.changeAwake("start", minutes: value == 0 ? nil : value, lid: lidOn) }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
            if let note = model.awakeNote { Footnote(note) }

            Footnote("Stops your Mac sleeping, on battery too, so Squeak can reach it from your iPhone while you are away. It ends by itself at the time shown.")
        }
    }

    // MARK: Lid closed

    private var lidSection: some View {
        SettingsCard(title: "Lid closed", subtitle: "Prepare your Mac to keep working with its lid shut.", symbol: "laptopcomputer") {
            if model.awakeLidReady {
                StatusLine(dot: Theme.working, text: "Ready", detail: "Your Mac can stay awake with the lid closed.")
            } else {
                StatusLine(dot: Theme.idle, text: "Not set up", detail: "Closing the lid still puts your Mac to sleep.")
                HStack(spacing: Space.s) {
                    if model.settingUpLid { ProgressView().controlSize(.small); Text("Waiting for your Mac password…").foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    Button("Set up lid closed…") { Task { await model.setUpLidClosed() } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(model.settingUpLid)
                }
            }
            if let problem = model.awakeSleepProblem {
                StatusLine(dot: Theme.error, text: "Sleep is still turned off", detail: problem)
            }

            Footnote(model.awakeLidReady
                ? "A hard, open surface keeps it coolest; in a bag, Squeak watches its heat (below). A lid closed session always has an end, and Squeak turns sleep back on when it ends or when Squeak quits."
                : "A one-time setup that asks for your Mac password, so Squeak can switch sleep off for a session. Nothing else is changed.")
        }
    }

    // MARK: Lid open | Lid closed

    /// The tab shown: the running session's mode while one runs, else the one the next start uses.
    private var shownLid: Bool { model.awake.map(\.lid) ?? withLid }

    /// The two modes, each with its own switches, kept apart: changing one never touches the other. With
    /// nothing running the tab picks the next session's mode; while one runs it switches the session, keeping its end.
    private var modeSection: some View {
        SettingsCard(title: "Mode", subtitle: "Choose how your Mac stays reachable.", symbol: "rectangle.split.2x1") {
            Picker("Mode", selection: Binding(get: { shownLid }, set: { closed in
                withLid = closed
                guard let awake = model.awake, awake.lid != closed else { return }
                if closed && !model.awakeLidReady { return }
                let left = AwakeRow.minutesLeft(awake.until)
                Task { await model.changeAwake("start", minutes: left ?? (closed ? 120 : nil), lid: closed) }
            })) {
                Text("Lid open").tag(false)
                Text("Lid closed").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if shownLid {
                ForEach(AwakeFormat.lidActionInfos) { info in
                    Toggle(isOn: Binding(
                        get: { model.awakeLidActions.map { AwakeFormat.value(info.key, in: $0) } ?? false },
                        set: { on in Task { await model.setLidAction(info.key, on) } }
                    )) {
                        SettingsControlLabel(title: info.title, detail: info.detail)
                    }
                }
            } else {
                ForEach(AwakeFormat.openActionInfos) { info in
                    Toggle(isOn: Binding(
                        get: { model.awakeOpenActions.map { AwakeFormat.value(info.key, in: $0) } ?? false },
                        set: { on in Task { await model.setOpenAction(info.key, on) } }
                    )) {
                        SettingsControlLabel(title: info.title, detail: info.detail)
                    }
                }
            }

            Footnote(shownLid
                ? (model.awakeLidReady ? "When the lid closes in a lid closed session. Each one is undone when the lid opens or the session ends."
                                       : "Lid closed needs setting up once, below. These are saved for then.")
                : "While a session runs with the lid open. Each one is undone when the session ends.")
        }
    }

    // MARK: When the lid closes

    private var actionsSection: some View {
        SettingsCard(title: "When the lid closes", subtitle: "Set what changes during a lid-closed session.", symbol: "laptopcomputer") {
            ForEach(AwakeFormat.lidActionInfos) { info in
                Toggle(isOn: Binding(
                    get: { model.awakeLidActions.map { AwakeFormat.value(info.key, in: $0) } ?? false },
                    set: { on in Task { await model.setLidAction(info.key, on) } }
                )) {
                    SettingsControlLabel(title: info.title, detail: info.detail)
                }
                .disabled(model.awakeLidActions == nil)
            }

            Footnote(model.awakeLidActions == nil
                ? "This version of the Squeak service doesn't offer these choices. Update it and they appear here."
                : "Only during a lid closed session. Each one is undone when the lid opens or the session ends.")
        }
    }

    // MARK: Safety

    private var safetySection: some View {
        SettingsCard(title: "Safety", subtitle: "Automatic limits for peace of mind while you’re away.", symbol: "shield") {
            StatusLine(dot: nil, text: AwakeFormat.lowPowerTitle(model.awakeRules),
                       detail: AwakeFormat.lowPowerDetail(model.awakeRules))
            StatusLine(dot: nil, text: AwakeFormat.endTitle(model.awakeRules),
                       detail: AwakeFormat.endDetail(model.awakeRules))
            if let ended = AwakeFormat.ended(model.awakeLastEnd) { Footnote(ended) }

            Footnote("These rules are always on. They protect the battery, and a Mac in a bag.")
        }
    }

    // MARK: Heat

    private var heatSection: some View {
        let heat = model.heat
        return SettingsCard(title: "Heat", subtitle: "Let Squeak respond when your Mac gets warm.", symbol: "thermometer.medium") {
            if let heat {
                StatusLine(
                    dot: heat.level == "hot" ? Theme.error : heat.level == "warm" ? Theme.needsYou : Theme.idle,
                    text: AwakeFormat.heatTitle(heat),
                    detail: heat.why ?? AwakeFormat.heatReading(heat))
            }
            if heat?.fanControl == true {
                StatusLine(dot: nil, text: "Fan control ready", detail: "When your Mac warms up during a session, its fans go to full.")
            } else {
                StatusLine(dot: nil, text: "Fan control not set up", detail: "macOS runs the fans on its own, and lets the chip get hot first.")
                HStack(spacing: Space.s) {
                    if model.settingUpFans { ProgressView().controlSize(.small); Text("Waiting for your Mac password…").foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    Button("Set up fan control…") { Task { await model.setUpFanControl() } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(model.settingUpFans)
                }
            }

            Footnote("During a session Squeak watches the chip and battery. When it warms up (battery 40°C, or the chip 90°C with the lid shut) it turns on Low Power Mode and moves your agents to the efficiency cores, so they keep going but slower. If the battery reaches 45°C for two minutes, it lets your Mac sleep. A closed bag still traps heat; fans help only a little there.")
        }
    }

    // MARK: Energy mode

    @ViewBuilder private var powerSection: some View {
        if let power = model.power, !power.available.isEmpty {
            SettingsCard(title: "Energy mode", subtitle: "Choose how your Mac uses power while awake.", symbol: "bolt") {
                if power.ready {
                    StatusLine(dot: nil, text: "Energy mode ready",
                               detail: power.mode.map { "Now \(DaemonPower.title($0))." + (power.overridden ? " Held on Low Power while your Mac is warm." : "") })
                } else {
                    StatusLine(dot: nil, text: "Energy mode not set up", detail: "Your iPhone can't change it until you set it up here.")
                    HStack(spacing: Space.s) {
                        if model.settingUpPower { ProgressView().controlSize(.small); Text("Waiting for your Mac password…").foregroundStyle(.secondary) }
                        Spacer(minLength: 0)
                        Button("Set up energy mode…") { Task { await model.setUpPower() } }
                            .buttonStyle(SecondaryButtonStyle()).disabled(model.settingUpPower)
                    }
                }

                Footnote("Automatic, Low Power or High Power, picked in Mac controls on your iPhone. This allows exactly those three settings, nothing else. Heat and the battery rules still switch to Low Power when they need to, and your pick returns afterwards.")
            }
        }
    }

    // MARK: Hotspot

    private var hotspotSection: some View {
        let hotspot = model.hotspot
        let configured = hotspot?.configured == true
        return SettingsCard(title: "Hotspot failover", subtitle: "Stay connected when your usual network drops.", symbol: "wifi") {
            if let hotspot, configured {
                StatusLine(
                    dot: hotspot.onHotspot ? Theme.working : Theme.idle,
                    text: hotspot.onHotspot ? "On your iPhone's hotspot" : (hotspot.enabled ? "Ready" : "Off"),
                    detail: hotspot.ssid.map { "Hotspot: \($0)" })
                if let note = hotspot.lastNote {
                    Footnote(note).foregroundStyle(hotspot.lastOk == false ? Theme.error : Theme.muted)
                }
            } else {
                StatusLine(dot: Theme.idle, text: "Not set up", detail: "Add your iPhone hotspot's name and password.")
            }
            LabeledContent("Hotspot name") {
                TextField("iPhone hotspot name", text: $hotspotName)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.username)
                    .onAppear { if hotspotName.isEmpty { hotspotName = hotspot?.ssid ?? "" } }
            }
            LabeledContent("Password") {
                SecureField(configured ? "Leave empty to keep it" : "Password", text: $hotspotPassword)
                    .textFieldStyle(.roundedBorder)
            }
            HStack(spacing: Space.s) {
                if model.savingHotspot { ProgressView().controlSize(.small) }
                Spacer(minLength: 0)
                if configured {
                    Button("Remove") { Task { await model.removeHotspot(); hotspotName = ""; hotspotPassword = "" } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(model.savingHotspot)
                }
                Button("Save") {
                    Task { if await model.saveHotspot(ssid: hotspotName, password: hotspotPassword) { hotspotPassword = "" } }
                }
                .buttonStyle(PrimaryButtonStyle()).disabled(model.savingHotspot)
            }
            if let note = model.hotspotNote { Footnote(note).foregroundStyle(Theme.error) }

            Footnote("When your Mac loses its internet for about 30 seconds during an awake session, or while an agent works, it joins your iPhone's Personal Hotspot, and goes back to its Wi-Fi when that returns. macOS hides Wi-Fi names from apps, so Squeak can't look the hotspot up: type its name as it shows in Settings, Personal Hotspot. The password stays in your Mac's Keychain. Turn the hotspot on before you leave: iOS doesn't let an app do that.")
        }
    }
}
