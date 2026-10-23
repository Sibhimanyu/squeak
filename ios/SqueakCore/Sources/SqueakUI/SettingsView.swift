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

/// The gear: which Mac this phone is paired with, how it is doing, and unpairing.
struct SettingsView: View {
    /// A tab of the app's own bar, not a sheet: there is nothing to dismiss.
    var inTab = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.squeakScreen) private var screen
    @State private var confirmingUnpair = false
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

    var body: some View {
        NavigationStack {
            Form {
                if !model.hiddenHere.isEmpty {
                    Section {
                        Button("Show \(model.hiddenHere.count) hidden \(model.hiddenHere.count == 1 ? "chat" : "chats") again") { model.showHiddenAgain() }
                            .frame(minHeight: 44)
                    } header: { Text("Hidden on this iPhone") } footer: {
                        Text("Hiding only tidies this iPhone. A hidden chat comes back by itself when it has news.")
                    }
                }
                if model.awakeOffered {
                    AwakeSection(problem: $awakeProblem)
                    if model.lidActionsOffered {
                        LidActionsSection(problem: $lidActionsProblem)
                    }
                }
                Section("Your Mac") {
                    LabeledContent("Name", value: model.snapshot?.mac ?? "Not seen yet")
                    TimelineView(.periodic(from: .now, by: 20)) { _ in
                        let state = model.connection()
                        LabeledContent("Status") {
                            HStack(spacing: 7) { StatusDot(color: state.color); Text(state.text) }
                        }
                    }
                    if !model.demo, model.snapshot != nil {
                        LabeledContent("Route", value: Connection.routeText(model.route))
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
            .toolbar { if !inTab { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } }
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

/// What the Mac does when its lid closes during a lid-closed session: four switches, each a signed change
/// to the Mac's own setting. Shown only for a Mac that sends them.
private struct LidActionsSection: View {
    @Environment(AppModel.self) private var model
    @Binding var problem: String?

    var body: some View {
        Section {
            ForEach(AwakeFormat.lidActionInfos) { info in
                Toggle(isOn: Binding(
                    get: { model.lidActions?[info.key] ?? false },
                    set: { on in Task { problem = await model.changeLidAction(info.key, on) } }
                )) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(info.title)
                            Text(info.detail).font(.footnote).foregroundStyle(Theme.muted)
                        }
                        if model.lidActionPending(info.key) { ProgressView() }
                    }
                }
                .tint(Theme.primaryFill)
                .frame(minHeight: 44)
                .accessibilityIdentifier("lid-action-\(info.key)")
            }
        } header: { Text("When the lid closes") } footer: {
            Text(problem ?? "Only during a lid closed session. Each one is undone when the lid opens or the session ends.")
        }
    }
}

/// The Mac's awake session: what it is doing now, then a way to start one for a while, add time or end it.
/// Everything shown is what the Mac reports; the phone only words it.
private struct AwakeSection: View {
    @Environment(AppModel.self) private var model
    @Binding var problem: String?
    @State private var confirmingEnd = false
    @State private var untilTime = Date().addingTimeInterval(3 * 3600)
    /// On unless you turn it off, and remembered: a Mac you set to stay awake should stay awake with its lid shut.
    /// Without the lid-closed setup on the Mac there is nothing to turn on, and the footer says so.
    @AppStorage("awakeWithLid") private var withLid = true

    private static let durations: [(String, String, Int)] = [("1h", "1 hour", 60), ("2h", "2 hours", 120), ("4h", "4 hours", 240), ("8h", "8 hours", 480)]

    var body: some View {
        Section {
            TimelineView(.periodic(from: .now, by: 15)) { _ in
                HStack(spacing: 10) {
                    if model.awake?.pending == true { ProgressView() } else { StatusDot(color: model.awake == nil ? Theme.idle : Theme.working) }
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Keep Mac awake").font(.headline)
                        Text(statusLine).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
            .frame(minHeight: 44)
            if let problem = model.snapshot?.awakeSleepProblem {
                HStack(alignment: .top, spacing: 10) {
                    StatusDot(color: Theme.error).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Sleep is still turned off").font(.body)
                        Text(problem).font(.footnote).foregroundStyle(Theme.muted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 4).frame(minHeight: 44)
                .accessibilityElement(children: .combine)
            }
            if let awake = model.awake {
                if let lid = awake.lid { lidRow(lid, problem: awake.lidProblem) }
                if let safety = awake.safety {
                    HStack(spacing: 10) {
                        StatusDot(color: Theme.idle)
                        Text(safety).font(.subheadline).foregroundStyle(Theme.muted)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
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
                if let ended = AwakeFormat.ended(model.snapshot?.awakeLastEnd) {
                    Text(ended).font(.footnote).foregroundStyle(Theme.muted)
                }
                if model.awakeLidReady {
                    Toggle(isOn: $withLid) {
                        Text("With the lid closed")
                        Text(withLid ? "Safe to close the lid. It always has an end." : "Closing the lid will sleep your Mac.")
                            .font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .tint(Theme.primaryFill)
                    .frame(minHeight: 44)
                }
                Text("Keep it awake for").font(.subheadline).foregroundStyle(Theme.muted)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
                    ForEach(Self.durations, id: \.0) { choice in
                        Button(choice.0) { change(.start(minutes: choice.2, lid: lid)) }
                            .buttonStyle(.bordered)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .accessibilityLabel("Keep awake for \(choice.1)")
                    }
                }
                .tint(Theme.primaryFill)
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
            Text(problem ?? footer)
        }
    }

    private var statusLine: String {
        guard let awake = model.awake else { return "Off. Your Mac sleeps as usual." }
        if awake.pending { return "Starting…" }
        guard let until = awake.until else { return "On until you end it" }
        return "On until \(until.formatted(date: .omitted, time: .shortened)) · \(Self.left(until)) left"
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
