#if os(iOS)
import SqueakCore
import SwiftUI

/// The gear: which Mac this phone is paired with, how it is doing, and unpairing.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.squeakScreen) private var screen
    @State private var confirmingUnpair = false
    @State private var awakeProblem: String?

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Your Mac") {
                    LabeledContent("Name", value: model.snapshot?.mac ?? "Not seen yet")
                    TimelineView(.periodic(from: .now, by: 20)) { _ in
                        let state = Connection.read(snapshot: model.snapshot, problem: model.problem, demo: model.demo, lastFetch: model.lastFetch)
                        LabeledContent("Status") {
                            HStack(spacing: 7) { StatusDot(color: state.color); Text(state.text) }
                        }
                    }
                    if let snapshot = model.snapshot {
                        if snapshot.workspaces == nil {
                            Text("New chats from this iPhone need a newer Squeak on your Mac. Update it and the button appears.")
                                .font(.subheadline).foregroundStyle(Theme.muted)
                        }
                        LabeledContent("Last change", value: Age.describe(snapshot.generatedAt) == "now" ? "Just now" : "\(Age.describe(snapshot.generatedAt)) ago")
                    }
                }
                if model.awakeOffered {
                    AwakeSection(problem: $awakeProblem)
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

    static func left(_ until: Date) -> String {
        let minutes = Int((until.timeIntervalSinceNow / 60).rounded(.up))
        if minutes <= 1 { return "under a minute" }
        let hours = minutes / 60
        if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
        return hours > 0 ? "\(hours)h \(minutes % 60)m" : "\(minutes)m"
    }
}
#endif
