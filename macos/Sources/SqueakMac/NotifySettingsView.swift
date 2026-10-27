import SqueakMacCore
import SwiftUI

/// Settings › Telegram and › Zoho Cliq: what that channel may push. Hidden for a channel that is not set
/// up, and while the daemon has not described it. Each control sends one change and shows it at once.
struct NotificationsSection: View {
    @Environment(AppModel.self) private var app
    let channel: NotifyChannel

    private var m: ChannelsModel { app.channels }

    var body: some View {
        if m.notify?.isSetUp(channel) == true, let s = m.notify?[channel] {
            Section {
                toggle("Mute \(channel.title)", detail: "Nothing is sent here, quota alerts included.", on: s.muted) { .muted($0) }
                Group {
                    toggle("Needs approval", on: s.approval) { .approval($0) }
                    toggle("Questions", detail: "A finished turn that ends on a question.", on: s.question) { .question($0) }
                    toggle("Seems stuck", on: s.stalled) { .stalled($0) }
                    toggle("Quota alerts", on: s.quota) { .quota($0) }
                    Picker("Finished", selection: Binding(
                        get: { s.finished }, set: { v in Task { await m.setNotify(channel, .finished(v)) } })) {
                        ForEach(NotifyFinished.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    quiet(s.quiet)
                }
                .disabled(s.muted)
                if let e = m.notifyError { Footnote(e) }
            } header: { Text(channel.title) } footer: {
                Footnote(m.notifyOutdated ? NotifyText.outdated : NotifyText.footnote)
            }
        } else if m.notifyOutdated, channel == .telegram ? m.tokenSet : m.webhookSet {
            Section { Footnote(NotifyText.outdated) } header: { Text(channel.title) }
        }
    }

    private func toggle(_ title: String, detail: String? = nil, on: Bool, make: @escaping (Bool) -> NotifyChange) -> some View {
        Toggle(isOn: Binding(get: { on }, set: { v in Task { await m.setNotify(channel, make(v)) } })) {
            Text(title)
            if let detail { Text(detail) }
        }
        .disabled(m.notifyOutdated)
    }

    @ViewBuilder private func quiet(_ q: NotifyQuiet?) -> some View {
        Toggle(isOn: Binding(
            get: { q != nil },
            set: { on in Task { await m.setNotify(channel, .quiet(on ? NotifyQuiet.standard : nil)) } })) {
            Text("Quiet hours")
            Text("Local time on this Mac.")
        }
        .disabled(m.notifyOutdated)
        if let q {
            DatePicker("From", selection: time(q.from) { .quiet(NotifyQuiet(from: $0, to: q.to)) }, displayedComponents: .hourAndMinute)
            DatePicker("To", selection: time(q.to) { .quiet(NotifyQuiet(from: q.from, to: $0)) }, displayedComponents: .hourAndMinute)
        }
    }

    private func time(_ clock: String, make: @escaping (String) -> NotifyChange) -> Binding<Date> {
        Binding(
            get: {
                let mins = NotifyQuiet.minutes(clock) ?? 0
                return Calendar.current.date(bySettingHour: mins / 60, minute: mins % 60, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let c = Calendar.current.dateComponents([.hour, .minute], from: date)
                let new = NotifyQuiet.clock(hour: c.hour ?? 0, minute: c.minute ?? 0)
                Task { await m.setNotify(channel, make(new)) }
            })
    }
}
