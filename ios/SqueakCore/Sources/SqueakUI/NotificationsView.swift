#if os(iOS)
import SqueakCore
import SwiftUI

/// Settings › Notifications: what Telegram and Cliq may push, one block per channel the Mac has set up.
/// The Mac owns the settings (`notify` in the phone view); a switch shows the tap at once and goes back with the
/// Mac's reason if it refuses.
struct NotificationsView: View {
    @Environment(AppModel.self) private var model
    @State private var problem: String?

    private var shown: [(id: String, title: String)] {
        guard let notify = model.snapshot?.notify else { return [] }
        return NotifyFormat.channels.filter { notify.configured($0.id) && model.notifySettings($0.id) != nil }
    }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering. Changes won't reach it.").font(.footnote).foregroundStyle(Theme.muted) }
            }
            if shown.isEmpty {
                Section { Text("No channel is set up on your Mac. Add Telegram or Cliq in Squeak there.").font(.footnote).foregroundStyle(Theme.muted) }
            }
            ForEach(shown, id: \.id) { channel in
                ChannelBlock(id: channel.id, title: channel.title, problem: $problem)
            }
            if !shown.isEmpty {
                Section {} footer: { Text(NotifyFormat.quietFootnote) }
            }
            if let problem {
                Section { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
    }
}

private struct ChannelBlock: View {
    let id: String
    let title: String
    @Binding var problem: String?
    @Environment(AppModel.self) private var model

    private var settings: NotifySettings.ChannelSettings { model.notifySettings(id) ?? .init() }

    private func send(_ change: NotifyChange) {
        Task { problem = await model.changeNotify(id, change) }
    }

    private func toggle(_ label: String, _ on: Bool, _ make: @escaping (Bool) -> NotifyChange) -> some View {
        Toggle(label, isOn: Binding(get: { on }, set: { send(make($0)) }))
            .tint(Theme.primaryFill).frame(minHeight: 44)
    }

    var body: some View {
        let s = settings
        Section {
            toggle("Mute", s.muted, NotifyChange.muted)
            Group {
                toggle("Needs approval", s.approval, NotifyChange.approval)
                toggle("Questions", s.question, NotifyChange.question)
                toggle("Seems stuck", s.stalled, NotifyChange.stalled)
                toggle("Quota alerts", s.quota, NotifyChange.quota)
                Picker("Finished", selection: Binding(get: { s.finished }, set: { send(.finished($0)) })) {
                    ForEach(NotifyFormat.finishedModes, id: \.id) { Text($0.title).tag($0.id) }
                }
                .frame(minHeight: 44)
                Toggle("Quiet hours", isOn: Binding(
                    get: { s.quiet != nil },
                    set: { send(.quiet($0 ? NotifyFormat.defaultQuiet : nil)) }))
                    .tint(Theme.primaryFill).frame(minHeight: 44)
                if let quiet = s.quiet {
                    QuietPickers(quiet: quiet) { updated in
                        if NotifyFormat.isValid(updated) {
                            problem = nil
                            send(.quiet(updated))
                        } else {
                            problem = "Quiet hours need different start and end times."
                        }
                    }
                }
            }
            .disabled(s.muted)
        } header: { Label(title, systemImage: id == "telegram" ? "paperplane" : "bubble.left") } footer: {
            if s.muted { Text("Nothing is pushed to \(title) while it's muted, quota alerts included.") }
        }
    }
}

private struct QuietPickers: View {
    let quiet: NotifySettings.Quiet
    let change: (NotifySettings.Quiet) -> Void

    private func date(_ clock: String) -> Date {
        let m = NotifyFormat.minutes(clock) ?? 0
        return Calendar.current.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()) ?? Date()
    }

    private func clock(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return NotifyFormat.clock(minutes: (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    var body: some View {
        DatePicker("From", selection: Binding(get: { date(quiet.from) }, set: { change(.init(from: clock($0), to: quiet.to)) }),
                   displayedComponents: .hourAndMinute)
            .frame(minHeight: 44)
        DatePicker("To", selection: Binding(get: { date(quiet.to) }, set: { change(.init(from: quiet.from, to: clock($0))) }),
                   displayedComponents: .hourAndMinute)
            .frame(minHeight: 44)
        if NotifyFormat.crossesMidnight(quiet) {
            Text("Ends the next morning. Your Mac's clock decides.").font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}
#endif
