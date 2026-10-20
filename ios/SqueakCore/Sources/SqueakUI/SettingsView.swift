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

/// The gear: which Mac this phone is paired with, how it is doing, and unpairing.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.squeakScreen) private var screen
    @State private var confirmingUnpair = false
    @State private var awakeProblem: String?

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

    var body: some View {
        NavigationStack {
            Form {
                Section("Your Mac") {
                    LabeledContent("Name", value: model.snapshot?.mac ?? "Not seen yet")
                    TimelineView(.periodic(from: .now, by: 20)) { _ in
                        let state = model.connection()
                        LabeledContent("Status") {
                            HStack(spacing: 7) { StatusDot(color: state.color); Text(state.text) }
                        }
                    }
                    if let snapshot = model.snapshot {
                        if snapshot.workspaces == nil {
                            Text("New chats from this iPhone need a newer Squeak on your Mac. Update it and the button appears.")
                                .font(.subheadline).foregroundStyle(Theme.muted)
                        }
                        if let power = snapshot.macPower {
                            // A Mac that stopped answering left these behind: say they are its last word.
                            let stale = Self.lastKnown(model.macLiveness())
                            if let percent = power.percent {
                                LabeledContent("Battery", value: Self.battery(percent: percent, power: power) + stale)
                            }
                            if let closed = power.lidClosed {
                                LabeledContent("Lid", value: (closed ? "Closed" : "Open") + stale)
                            }
                        }
                        LabeledContent("Last change", value: Age.describe(snapshot.generatedAt) == "now" ? "Just now" : "\(Age.describe(snapshot.generatedAt)) ago")
                    }
                    NavigationLink("Connection details") { ConnectionDetailsView() }
                        .frame(minHeight: 44)
                }
                if model.awakeOffered {
                    AwakeSection(problem: $awakeProblem)
                }
                if let hotspot = model.snapshot?.hotspot {
                    HotspotSection(hotspot: hotspot)
                }
                Section {
                    Toggle("Show thinking live", isOn: Bindable(model).verbose)
                        .tint(Theme.primaryFill)
                        .frame(minHeight: 44)
                } header: { Text("Activity") } footer: {
                    Text(model.liveAvailable
                        ? "A working chat's steps show its whole turn as it happens, thinking included. Your Mac sends it only while that chat is open here, and deletes it when you leave."
                        : "Needs your Mac on Squeak's faster channel. Until then, a working chat shows its latest six steps.")
                }
                Section {
                    Text("Replies are signed on this iPhone and checked by your Mac. Face ID is asked before the first one, and again after Squeak has been away for five minutes.")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                } header: { Text("Security") }
                if let openReport = screen.openReport {
                    Section {
                        Button("Report a problem") {
                            // Close Settings first: the report sheet can't stack on this one.
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { openReport() }
                        }
                        .frame(minHeight: 44)
                    } header: { Text("Feedback") } footer: {
                        Text("Tell us what's broken, confusing or could be better. A person reads every report.")
                    }
                }
                Section {
                    Button("Unpair this iPhone", role: .destructive) { confirmingUnpair = true }
                        .frame(minHeight: 44)
                } footer: {
                    if !version.isEmpty { Text("Squeak for iPhone \(version)") }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { model.unpair(); dismiss() }
            } message: {
                Text("It will stop seeing and answering your agents until you pair again.")
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
        } header: { Text("Hotspot") } footer: {
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

/// The Mac's awake session: start one for a while or until ended, add time, or end it.
private struct AwakeSection: View {
    @Environment(AppModel.self) private var model
    @Binding var problem: String?
    @State private var confirmingEnd = false
    @State private var untilTime = Date().addingTimeInterval(3 * 3600)
    @State private var withLid = false

    private static let durations: [(String, Int)] = [("1h", 60), ("2h", 120), ("4h", 240), ("8h", 480)]

    var body: some View {
        Section {
            if let awake = model.awake {
                TimelineView(.periodic(from: .now, by: 30)) { _ in
                    LabeledContent("Awake") {
                        Text(awake.until.map { "until \($0.formatted(date: .omitted, time: .shortened)) · \(Self.left($0)) left" }
                             ?? "until you end it")
                    }
                }
                .frame(minHeight: 44)
                if let lid = awake.lid {
                    LabeledContent("Lid closed") {
                        Text(lid == "on" ? "Stays awake" : lid == "starting" ? "Turning on…" : "Didn't turn on")
                    }
                    .frame(minHeight: 44)
                }
                if let safety = awake.safety {
                    LabeledContent("Safety") { Text(safety) }
                        .frame(minHeight: 44)
                }
                if awake.until != nil {
                    Button("Add 1 hour") { change(.extend(minutes: 60)) }
                        .frame(minHeight: 44)
                }
                Button("End awake session", role: .destructive) { confirmingEnd = true }
                    .frame(minHeight: 44)
                    .confirmationDialog("Let your Mac sleep again?", isPresented: $confirmingEnd, titleVisibility: .visible) {
                        Button("End awake session", role: .destructive) { change(.end) }
                    }
            } else {
                if model.awakeLidReady {
                    Toggle("Lid closed too", isOn: $withLid)
                        .tint(Theme.primaryFill)
                        .frame(minHeight: 44)
                }
                HStack(spacing: 8) {
                    ForEach(Self.durations, id: \.0) { choice in
                        Button(choice.0) { change(.start(minutes: choice.1, lid: lid)) }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity)
                    }
                }
                .tint(Theme.primaryFill)
                .frame(minHeight: 44)
                HStack(spacing: 12) {
                    DatePicker("Until", selection: $untilTime, displayedComponents: .hourAndMinute)
                    Button("Start") { change(.start(minutes: Self.minutes(until: untilTime), lid: lid)) }
                        .buttonStyle(.bordered)
                        .tint(Theme.primaryFill)
                }
                .frame(minHeight: 44)
                // A lid-closed session always ends by itself.
                if !lid {
                    Button("Until I end it") { change(.start(minutes: nil)) }
                        .tint(Theme.primaryFill)
                        .frame(minHeight: 44)
                }
            }
        } header: { Text("Keep Mac awake") } footer: {
            Text(problem ?? model.awake?.lidProblem ?? footer)
        }
    }

    private var lid: Bool { withLid && model.awakeLidReady }

    private var footer: String {
        if model.awakeLidReady {
            return "Stops your Mac sleeping, on battery too, so this iPhone can reach it. With the lid closed too, keep it on a hard, open surface — never in a bag."
        }
        return "Stops your Mac sleeping, on battery too, so this iPhone can reach it. Closing the lid still sleeps it unless you set up lid-closed in Squeak on the Mac."
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
