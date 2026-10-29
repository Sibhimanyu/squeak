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

/// The walkthrough version keeps the same notification bindings while arranging them as a compact,
/// branded channel card instead of nesting a full Settings form.
struct NotificationSetupChannel: View {
    @Environment(AppModel.self) private var app
    let channel: NotifyChannel
    private var model: ChannelsModel { app.channels }

    var body: some View {
        if model.notify?.isSetUp(channel) == true, let settings = model.notify?[channel] {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Space.s) {
                    Image(systemName: channel == .telegram ? "paperplane.fill" : "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.duck)
                        .frame(width: 28, height: 28)
                        .background(Theme.duck.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
                    Text(channel.title).font(Typo.label).foregroundStyle(Theme.ink)
                    Spacer()
                    if model.notifyOutdated {
                        Text("Update service").font(Typo.meta).foregroundStyle(Theme.needsYou)
                    }
                }
                .padding(.bottom, 8)

                channelToggle("Mute \(channel.title)", detail: "Nothing is sent here, quota alerts included.", on: settings.muted) { .muted($0) }
                Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 5)

                VStack(spacing: 0) {
                    channelToggle("Needs approval", on: settings.approval) { .approval($0) }
                    channelToggle("Questions", detail: "A finished turn that ends on a question.", on: settings.question) { .question($0) }
                    channelToggle("Seems stuck", on: settings.stalled) { .stalled($0) }
                    channelToggle("Quota alerts", on: settings.quota) { .quota($0) }
                }
                .disabled(settings.muted || model.notifyOutdated)
                .opacity(settings.muted ? 0.55 : 1)

                Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 5)
                HStack(spacing: 10) {
                    Text("Finished sessions").font(Typo.body).foregroundStyle(Theme.ink)
                    Spacer(minLength: 4)
                    Picker("Finished sessions", selection: Binding(
                        get: { settings.finished }, set: { value in Task { await model.setNotify(channel, .finished(value)) } })) {
                        ForEach(NotifyFinished.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize(horizontal: true, vertical: false)
                    .accessibilityLabel("Finished sessions on \(channel.title)")
                    .disabled(settings.muted || model.notifyOutdated)
                }
                .padding(.vertical, 5)
                quietHours(settings.quiet)

                if let error = model.notifyError {
                    Text(error).font(Typo.meta).foregroundStyle(Theme.error).padding(.top, 8)
                } else if model.notifyOutdated {
                    Text(NotifyText.outdated).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, 8)
                }
            }
            .padding(Space.m)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        } else if model.notifyOutdated, channel == .telegram ? model.tokenSet : model.webhookSet {
            HStack(spacing: Space.s) {
                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Theme.needsYou)
                Text("\(channel.title): \(NotifyText.outdated)").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        }
    }

    private func channelToggle(_ title: String, detail: String? = nil, on: Bool,
                               make: @escaping (Bool) -> NotifyChange) -> some View {
        let binding = Binding(get: { on }, set: { value in Task { await model.setNotify(channel, make(value)) } })
        return HStack(spacing: Space.m) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Typo.body).foregroundStyle(Theme.ink)
                if let detail { Text(detail).font(Typo.meta).foregroundStyle(Theme.muted) }
            }
            Spacer(minLength: Space.s)
            Toggle(title, isOn: binding)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .accessibilityLabel("\(title) for \(channel.title)")
        }
        .disabled(model.notifyOutdated)
        .padding(.vertical, 5)
    }

    @ViewBuilder private func quietHours(_ quiet: NotifyQuiet?) -> some View {
        let binding = Binding(get: { quiet != nil }, set: { enabled in
            Task { await model.setNotify(channel, .quiet(enabled ? NotifyQuiet.standard : nil)) }
        })
        HStack(spacing: Space.m) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Quiet hours").font(Typo.body).foregroundStyle(Theme.ink)
                Text("Local time on this Mac.").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: Space.s)
            Toggle("Quiet hours", isOn: binding)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .accessibilityLabel("Quiet hours for \(channel.title)")
        }
        .disabled(model.notifyOutdated || quiet != nil && model.notify?[channel]?.muted == true)
        .padding(.vertical, 5)
        if let quiet {
            HStack(spacing: Space.m) {
                timePicker("From", clock: quiet.from) { .quiet(NotifyQuiet(from: $0, to: quiet.to)) }
                timePicker("To", clock: quiet.to) { .quiet(NotifyQuiet(from: quiet.from, to: $0)) }
                Spacer(minLength: 0)
            }
            .padding(.leading, 2)
            .disabled(model.notifyOutdated || model.notify?[channel]?.muted == true)
        }
    }

    private func timePicker(_ title: String, clock: String, make: @escaping (String) -> NotifyChange) -> some View {
        let binding = Binding<Date>(get: {
            let minutes = NotifyQuiet.minutes(clock) ?? 0
            return Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date()) ?? Date()
        }, set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            Task { await model.setNotify(channel, make(NotifyQuiet.clock(hour: parts.hour ?? 0, minute: parts.minute ?? 0))) }
        })
        return DatePicker(title, selection: binding, displayedComponents: .hourAndMinute)
            .datePickerStyle(.compact)
            .controlSize(.small)
    }
}
