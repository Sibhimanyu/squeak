import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The Controls tab's header.
struct PopupControlsHeader: View {
    var body: some View {
        PopupTabHeader(selected: .controls) {
            Text("Controls").font(.popup(22, .bold)).foregroundStyle(Theme.ink)
        } trailing: { EmptyView() }
    }
}

/// Keep awake, Notifications and Your Mac, from the same models Settings uses. Rows with no data are
/// left out rather than invented.
struct PopupControlsBand: View {
    @Environment(AppModel.self) private var model
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            if model.awakeOffered { PopupAwakeCard() }
            PopupNotifyCard()
            PopupMacCard()
            Button { dismiss(); model.showConversationWindow() } label: {
                HStack(spacing: 10) {
                    Lucide(.externalLink, size: 16, color: Theme.ink)
                    Text("Open Squeak")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(PopupButtonStyle(radius: 11, height: 36, size: 14.5))
        }
        .padding(.horizontal, PopupMetrics.inset)
        .padding(.bottom, 16)
        .task { await model.readAwake() }
        .task { if !model.demoMode { await model.channels.refresh() } }
    }
}

// MARK: Keep awake

struct PopupAwakeCard: View {
    @Environment(AppModel.self) private var model
    @AppStorage("awakeWithLid") private var withLid = true
    @State private var localNote: String?
    let nav = PopupNav.shared
    private static let lengths: [(id: Int, title: String)] = [(60, "1h"), (120, "2h"), (240, "4h"), (480, "8h"), (0, "Until")]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            card(now: ctx.date)
        }
        .onChange(of: model.awake?.until, initial: true) { _, until in nav.observeAwake(until: until) }
    }

    private func card(now: Date) -> some View {
        let awake = model.awake
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(awake == nil ? Theme.idle : Theme.working).frame(width: 11, height: 11).padding(.top, 4).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keep Mac awake").font(.popup(15.5, .semibold)).foregroundStyle(Theme.ink)
                    Text(status(awake, now: now)).font(.popup(13.5)).foregroundStyle(Theme.muted).monospacedDigit()
                }
                Spacer(minLength: 8)
                if awake != nil {
                    Button("End") { Task { await model.changeAwake("end") } }
                        .buttonStyle(PopupButtonStyle(height: 29, hPad: 16, size: 13.5))
                        .accessibilityLabel("End keep awake")
                }
            }
            if let awake, let until = awake.until, let left = nav.awakeRemaining(until: until, now: now) {
                PopupBar(fraction: left, fill: Theme.working, track: Color.wash(0.13), height: 9).padding(.top, 12)
            }
            PopupSegmented(items: Self.lengths, selection: selectedLength(awake), height: 32, size: 14,
                           enabled: !model.settingUpLid) { pick($0) }
                .padding(.top, 12)
            PopupDivider().padding(.top, 12)
            lidRow(awake)
            if let note = localNote ?? model.awakeNote {
                Text(note).font(.popup(12.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            }
            if let problem = model.awakeSleepProblem {
                Text(problem).font(.popup(12.5)).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            }
        }
        .padding(14)
        .popupCard(radius: 13)
    }

    private func status(_ awake: DaemonAwake?, now: Date) -> String {
        guard let awake else { return "Off. Your Mac sleeps as usual." }
        let head = AwakeFormat.headline(awake)
        guard let left = AwakeFormat.left(until: awake.until, now: now) else { return head }
        return "\(head), \(left)"
    }

    private func selectedLength(_ awake: DaemonAwake?) -> Int? {
        guard let awake else { return nil }
        guard let until = awake.until else { return 0 }
        guard let total = nav.awakeSpan?.total else { return nil }
        let minutes = total / 60
        return Self.lengths.dropLast().first { abs(Double($0.id) - minutes) <= Double($0.id) * 0.12 }?.id
    }

    private var lidOn: Bool { model.awake?.lid ?? (withLid && model.awakeLidReady) }

    private func pick(_ id: Int) {
        let lid = model.awake?.lid ?? (withLid && model.awakeLidReady)
        // A lid-closed session must end, so "Until I end it" is not one of its choices.
        if id == 0, lid { localNote = "A closed-lid session needs an end time. Pick a length."; return }
        localNote = nil
        nav.willStartAwake(minutes: id == 0 ? nil : id)
        Task { await model.changeAwake("start", minutes: id == 0 ? nil : id, lid: lid) }
    }

    @ViewBuilder private func lidRow(_ awake: DaemonAwake?) -> some View {
        PopupIconRow(icon: AnyView(PopupSymbol(name: "laptopcomputer", size: 19, color: Theme.muted)), title: "With the lid closed") {
            if model.awakeLidReady {
                PopupSwitch(label: "With the lid closed", isOn: Binding(get: { lidOn }, set: { setLid($0) }), enabled: !model.settingUpLid)
            } else if model.settingUpLid {
                ProgressView().controlSize(.small)
            } else {
                Button("Set up…") { Task { await model.setUpLidClosed() } }
                    .buttonStyle(PopupButtonStyle(height: 26, hPad: 10, size: 12.5))
            }
        }
        .padding(.top, 8)
    }

    private func setLid(_ on: Bool) {
        guard let awake = model.awake else { withLid = on; return }
        // The session carries its lid choice, so changing it restarts it for the time left.
        guard let minutes = AwakeRow.minutesLeft(awake.until) else {
            if !on { Task { await model.changeAwake("start", lid: false) } }
            return
        }
        nav.willStartAwake(minutes: nav.awakeSpan.map { Int($0.total / 60) })
        Task { await model.changeAwake("start", minutes: minutes, lid: on) }
    }
}

// MARK: Notifications

/// Quick toggles for what Telegram and Zoho Cliq may push. Each is shown at once (the model applies it
/// optimistically) and put back when the daemon refuses; a change goes to every channel that is set up.
struct PopupNotifyCard: View {
    @Environment(AppModel.self) private var model

    private var m: ChannelsModel { model.channels }
    private var channels: [NotifyChannel] { m.notify?.shown ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Notifications").font(.popup(15.5, .semibold)).foregroundStyle(Theme.ink).padding(.bottom, 6)
            if let s = channels.first.flatMap({ m.notify?[$0] }) {
                row("bell", "Mute all", on: s.muted) { .muted($0) }
                rowDivider
                row("checkmark.circle", "Approvals", on: s.approval, disabled: s.muted) { .approval($0) }
                rowDivider
                row("questionmark.circle", "Questions", on: s.question, disabled: s.muted) { .question($0) }
                rowDivider
                finishedRow(s)
                if let e = m.notifyError {
                    Text(e).font(.popup(12.5)).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
                }
            } else {
                Text(m.notifyOutdated ? NotifyText.outdated : "Set up Telegram or Zoho Cliq in Settings to choose what they push.")
                    .font(.popup(13.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).padding(.vertical, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .popupCard(radius: 13)
    }

    private var rowDivider: some View { PopupDivider().padding(.leading, 36) }

    private func row(_ symbol: String, _ title: String, on: Bool, disabled: Bool = false, make: @escaping (Bool) -> NotifyChange) -> some View {
        PopupIconRow(icon: AnyView(PopupSymbol(name: symbol, size: 18, color: Theme.muted)), title: title) {
            PopupSwitch(label: title, isOn: Binding(get: { on }, set: { v in change(make(v)) }), enabled: !disabled && !m.notifyOutdated)
        }
        .frame(minHeight: 36)
    }

    /// On: Finished pushes only for Conductor chats. Off: for every agent. A channel set to Off says so.
    private func finishedRow(_ s: ChannelNotify) -> some View {
        let title = s.finished == .conductor ? "Finished: Conductor only" : "Finished: \(s.finished.title)"
        return PopupIconRow(icon: AnyView(PopupSymbol(name: "terminal", size: 18, color: Theme.muted)), title: title) {
            PopupSwitch(label: "Finished: Conductor only", isOn: Binding(
                get: { s.finished == .conductor }, set: { v in change(.finished(v ? .conductor : .all)) }),
                enabled: !s.muted && !m.notifyOutdated)
        }
        .frame(minHeight: 36)
    }

    private func change(_ c: NotifyChange) {
        Task { for channel in channels { await m.setNotify(channel, c) } }
    }
}

// MARK: Your Mac

struct PopupMacCard: View {
    @Environment(AppModel.self) private var model
    let nav = PopupNav.shared

    private var power: DaemonPower? { model.demoMode ? nav.demoPower : model.power }
    private var battery: Int? { model.demoMode ? 82 : PopupMac.batteryPercent() }
    private var name: String { model.demoMode ? "Sibhi's MacBook" : PopupMac.name }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Your Mac").font(.popup(15.5, .semibold)).foregroundStyle(Theme.ink).padding(.bottom, 6)
            HStack(spacing: 14) {
                PopupSymbol(name: "laptopcomputer", size: 19, color: Theme.muted)
                HStack(spacing: 7) {
                    Text(verbatim: name).font(.popup(14.5)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text("·").foregroundStyle(Theme.muted)
                    Text(model.homeConnectionText).font(.popup(14)).foregroundStyle(Theme.muted).lineLimit(1)
                    Circle().fill(model.homeConnectionColor).frame(width: 7, height: 7)
                }
                Spacer(minLength: 4)
                if let battery {
                    HStack(spacing: 7) {
                        PopupSymbol(name: battery > 66 ? "battery.100" : battery > 33 ? "battery.50" : "battery.25", size: 19, color: Theme.ink)
                        Text("\(battery)%").font(.popup(14)).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                    .accessibilityElement(children: .combine).accessibilityLabel("Battery \(battery) percent")
                }
            }
            .frame(minHeight: 36)
            if let power, power.available.count > 1, let mode = power.mode {
                PopupDivider().padding(.leading, 36)
                HStack(spacing: 14) {
                    PopupSymbol(name: "bolt", size: 19, color: Theme.muted)
                    Text("Power mode").font(.popup(14.5)).foregroundStyle(Theme.ink)
                    Spacer(minLength: 8)
                    PopupSegmented(items: power.available.map { ($0, $0 == "auto" ? "Auto" : $0.capitalized) }, selection: mode,
                                   height: 30, size: 13.5, enabled: false) { _ in }
                        .frame(width: 200)
                        .opacity(0.9)
                        .help("Energy mode is picked on your iPhone; this shows what is in use.")
                }
                .frame(minHeight: 40)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .popupCard(radius: 13)
    }
}
