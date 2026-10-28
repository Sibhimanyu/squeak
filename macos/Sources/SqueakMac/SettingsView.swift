import AppKit
import Heresay
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Settings, inside the main window: the sidebar swaps to a back row and the settings pages, and the
/// content area shows the chosen page as a grouped form. Escape or Back returns to sessions with the
/// previous filter and chat untouched.
struct SettingsShell: View {
    @Environment(AppModel.self) private var model
    @State private var visibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility) {
            SettingsSidebar()
                .navigationSplitViewColumnWidth(min: 200, ideal: 216, max: 280)
        } detail: {
            SettingsPage(section: model.settingsSection ?? .general)
        }
        .modifier(HiddenTitle())
        .background {
            Button("Back to sessions") { model.closeSettings() }
                .keyboardShortcut(.cancelAction)
                .opacity(0).accessibilityHidden(true)
        }
    }
}

private struct HiddenTitle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15, *) { content.toolbar(removing: .title) } else { content }
    }
}

private extension SettingsSection {
    var symbol: LucideName {
        switch self {
        case .general: .settings
        case .notifications: .bell
        case .awake: .moon
        case .conductor: .squareTerminal
        case .connections: .link
        case .telegram: .send
        case .cliq: .messageSquare
        case .iphone: .smartphone
        case .privacy: .hand
        case .about: .info
        }
    }
}

struct SettingsSidebar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List(selection: Binding(get: { model.settingsSection }, set: { if let s = $0 { model.settingsSection = s } })) {
            ForEach(Array(SettingsSection.groups.enumerated()), id: \.offset) { _, group in
                Section {
                    ForEach(group) { section in
                        LucideLabel(section.title, section.symbol).tag(section)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { back }
    }

    private var back: some View {
        Button { model.closeSettings() } label: {
            HStack(spacing: 6) {
                Lucide(.chevronLeft, size: 16, color: Theme.muted)
                Text("Back to sessions").font(Typo.body)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(Theme.muted)
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 10)
        .help("Back to sessions (Esc)")
        .accessibilityLabel("Back to sessions")
    }
}

/// One page: its title, then the form. Capped in width so rows stay readable in a wide window.
private struct SettingsPage: View {
    let section: SettingsSection

    var body: some View {
        VStack(spacing: 0) {
            Text(section.title).font(Typo.title).accessibilityAddTraits(.isHeader)
                .frame(maxWidth: 680, alignment: .leading)
                .padding(.leading, 48).padding(.trailing, 28).padding(.top, 8).padding(.bottom, 4)
            page.frame(maxWidth: 680)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .id(section)
    }

    @ViewBuilder private var page: some View {
        switch section {
        case .general: GeneralSettings()
        case .notifications: NotificationsSettings()
        case .awake: AwakeSettings()
        case .conductor: ConductorSettings()
        case .connections: ConnectionsSettings()
        case .telegram: TelegramSettings()
        case .cliq: CliqSettings()
        case .iphone: IPhoneSettings()
        case .privacy: PrivacySettings()
        case .about: AboutSettings()
        }
    }
}

/// Native-style section footer: leading-aligned, secondary, wraps.
private struct SectionFootnote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.callout).foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Settings › Notifications: this Mac's banners, then what each set-up channel may push.
private struct NotificationsSettings: View {
    @Environment(AppModel.self) private var model
    @State private var bannersShown: Bool?

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Toggle("Notify me on this Mac when a session needs me or finishes", isOn: $model.notificationsEnabled)
                    .disabled(!Bundled.isApp)
                if model.notificationsEnabled, bannersShown == false {
                    LabeledContent {
                        Button("Open Notification Settings") { GeneralSettings.openNotificationSettings() }
                    } label: {
                        Text("macOS isn't showing Squeak's banners")
                        Text("They only land in Notification Center. Set Squeak's alert style to Banners or Alerts.")
                    }
                }
            } footer: {
                SectionFootnote("Approvals, questions, plans to review, errors, and finished Conductor chats. Reply to a finished chat from the notification itself.")
            }
            ForEach(NotifyChannel.allCases, id: \.self) { NotificationsSection(channel: $0) }
            if model.channels.notify?.shown.isEmpty ?? true {
                Section { SectionFootnote("Set up Telegram or Zoho Cliq to choose what each one pushes.") }
            }
        }
        .formStyle(.grouped)
        .task { bannersShown = await Notifier.shared.bannersShown(); await model.channels.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { bannersShown = await Notifier.shared.bannersShown() }
        }
    }
}

private struct GeneralSettings: View {
    @Environment(AppModel.self) private var model
    private let hotKeys = HotKeyCenter.shared
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String?

    var body: some View {
        @Bindable var model = model
        Form {
            macCard
            Section {
                Toggle("Open Squeak when I log in", isOn: Binding(
                    get: { loginOn },
                    set: { on in
                        do {
                            try LoginItem.set(on)
                            loginOn = LoginItem.isEnabled
                            loginError = nil
                        } catch {
                            loginOn = LoginItem.isEnabled
                            loginError = error.localizedDescription
                        }
                    }
                ))
                .disabled(!Bundled.isApp)
            } footer: {
                if let loginError {
                    SectionFootnote(loginError)
                } else if !Bundled.isApp {
                    SectionFootnote("Available when running the Squeak app, not from a build folder.")
                }
            }
            Section {
                Picker("Quick message shortcut", selection: Binding(get: { model.hotKeyID ?? "" }, set: { model.hotKeyID = $0.isEmpty ? nil : $0 })) {
                    ForEach(HotKeyPreset.all) { preset in
                        Text(preset.title).tag(preset.id).accessibilityLabel(preset.title)
                    }
                    Text("None").tag("")
                }
                if hotKeys.needsInputMonitoring {
                    LabeledContent {
                        HStack {
                            Button("Allow Input Monitoring") { hotKeys.requestInputMonitoring() }
                            if hotKeys.requestedThisRun { Button("Relaunch Squeak") { hotKeys.relaunch() } }
                        }
                    } label: {
                        Text("Squeak needs Input Monitoring")
                        Text("Double-tap needs Input Monitoring so Squeak can notice Control taps. It never reads what you type.")
                    }
                }
            } footer: {
                if let error = hotKeys.registrationError {
                    SectionFootnote(error)
                } else if hotKeys.needsInputMonitoring {
                    SectionFootnote("Until it's allowed, ⌃⇧ Space opens the quick message. If you just allowed it and nothing changed, relaunch Squeak.")
                } else if model.hotKeyID == QuickShortcut.controlShiftSpace || model.hotKeyID == QuickShortcut.optionSpace {
                    SectionFootnote("A key combination from any app, with no special permission. Pick a different one if an app already uses it.")
                } else {
                    let key = model.hotKeyID == QuickShortcut.doubleOption ? "Option" : "Control"
                    SectionFootnote("Tap \(key) twice, quickly and on its own, from any app. Holding \(key) to use it with another key never counts.")
                }
            }
        }
        .formStyle(.grouped)
    }

    private var macCard: some View {
        let r = model.connectionsReport
        return Section {
            Card {
                VStack(alignment: .leading, spacing: Space.s) {
                    macRow("Conductor", r.database)
                    macRow("Squeak service", r.daemon)
                    macRow("Sending", r.sending)
                }
            }
            .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
        } footer: {
            SectionFootnote("Details are under Connections.")
        }
    }

    private func macRow(_ name: String, _ row: ConnectionsReport.Row) -> some View {
        HStack {
            Text(name).font(Typo.body).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            Text(row.value).font(Typo.body).foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .combine)
    }

    static func openNotificationSettings() {
        let id = Bundle.main.bundleIdentifier ?? "com.squeak.mac"
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
            NSWorkspace.shared.open(url)
        }
    }
}

private struct ConnectionsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let r = model.connectionsReport
        Form {
            Section {
                row(r.database, name: "Conductor", okWord: "reading chats", okColor: Theme.working)
                row(r.daemon, name: "Squeak service", okWord: "connected", okColor: Theme.working)
                row(r.sending, name: "Sending", okWord: "available", okColor: Theme.done)
            } footer: {
                SectionFootnote("Squeak reads agent chats locally and sends replies only when you choose.")
            }
            Section {
                ForEach(model.channels.summary) { channelRow($0) }
            } header: { Text("Channels") } footer: {
                SectionFootnote("Set these up under Telegram, Zoho Cliq and iPhone in Settings.")
            }
            Section {
                LabeledContent("Address") { Text(verbatim: model.client.baseURL.absoluteString).textSelection(.enabled) }
                if let synced = model.lastSyncedText { LabeledContent("Sync") { Text(synced) } }
                Button("Check again") { model.recheck() }
            } footer: {
                if let help = model.connectionHelp { SectionFootnote(help) }
            }
        }
        .formStyle(.grouped)
        .task { await model.channels.refresh() }
    }

    private func channelRow(_ r: ChannelsModel.SummaryRow) -> some View {
        HStack(spacing: 12) {
            // Only a real state gets a dot (§3.3); "not set up" and "one-way" are plain text.
            switch r.dot {
            case .working: Circle().fill(Theme.working).frame(width: 9, height: 9).accessibilityHidden(true)
            case .error: Circle().fill(Theme.error).frame(width: 9, height: 9).accessibilityHidden(true)
            case .none: EmptyView()
            }
            (Text(r.name).font(.system(size: 13, weight: .medium)) + Text("  —  ").foregroundStyle(.secondary) + Text(r.value).foregroundStyle(.secondary))
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private func row(_ r: ConnectionsReport.Row, name: String, okWord: String, okColor: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Circle().fill(color(r.level, ok: okColor)).frame(width: 9, height: 9)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                (Text(name).font(.system(size: 13, weight: .medium))
                    + Text("  —  ").foregroundStyle(.secondary)
                    + Text(r.level == .ok ? okWord : r.value.lowercased()).foregroundStyle(.secondary))
                if let d = r.detail, r.level != .ok {
                    Text(d).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(r.level == .ok ? okWord : r.value)")
    }

    private func color(_ l: ConnectionsReport.Level, ok: Color) -> Color {
        switch l {
        case .ok: ok
        case .warning: Theme.error
        case .problem: Theme.needsYou
        case .neutral: Theme.subtle
        }
    }
}

private struct PrivacySettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirm = false

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Toggle("Show session names in notifications", isOn: $model.notificationsShowNames)
            } footer: {
                SectionFootnote("Off by default. With this off, notifications don't name the session. With it on, they also show what an agent is asking; never other message text.")
            }
            Section {
                Button("Purge cache…", role: .destructive) { confirm = true }
            } header: {
                Text("Message cache")
            } footer: {
                SectionFootnote(model.cacheNotice ?? "Messages are encrypted on this Mac, kept 14 days, up to 50 MB.")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Delete the message cache and its encryption key?", isPresented: $confirm) {
            Button("Delete cache", role: .destructive) { Task { await model.purgeCache() } }
        } message: {
            Text("Drafts stored with it are deleted too. Nothing in Conductor changes.")
        }
    }
}

private struct AboutSettings: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                VStack(spacing: 6) {
                    DuckMark(width: 56)
                    Text("Squeak").font(.title2.bold())
                    Text("Version \(AppModel.appVersion)").foregroundStyle(.secondary)
                    Text("A pager for your coding agents. Reads your sessions and lets you answer them.")
                        .multilineTextAlignment(.center).font(.callout).foregroundStyle(.secondary).frame(maxWidth: 320)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 8)
            }
                Section {
                    Toggle("Automatically check for updates", isOn: Binding(get: { model.updater.automaticallyChecks }, set: { model.updater.automaticallyChecks = $0 }))
                        .disabled(!model.updater.isActive)
                    Toggle("Tell me when an update is available", isOn: $model.updateAlertsEnabled)
                    Toggle("Download and install updates automatically", isOn: Binding(get: { model.updater.automaticallyInstalls }, set: { model.updater.automaticallyInstalls = $0 }))
                        .disabled(!model.updater.isActive)
                    if let ready = model.updater.readyVersion {
                        LabeledContent("Update \(ready) is ready") { Button("Restart to update") { model.updater.installNow() } }
                        UpdateNotesDisclosure(notes: model.updater.readyNotes, size: 12)
                    } else if let available = model.updater.availableVersion {
                        LabeledContent("Update \(available) available") { Button("Install") { model.updater.checkForUpdates() } }
                        UpdateNotesDisclosure(notes: model.updater.availableNotes, size: 12)
                    }
                    if let note = model.updateNote { Text(note).foregroundStyle(.secondary) }
                    Button("Check for updates…") { model.updater.checkForUpdates() }
                        .disabled(!model.updater.canCheck)
                } footer: {
                    SectionFootnote("Squeak checks once a day, and installs a new version for you when you quit or relaunch it, then reopens what you had open. Nothing about your chats is sent.")
                }
                Section {
                    BackgroundServiceRow(daemon: model.daemon)
                } footer: {
                    SectionFootnote(BackgroundServiceRow.footnote(model.daemon.status))
                }
                Section {
                    Button(copied ? "Copied" : "Copy diagnostics") {
                        model.copyDiagnostics()
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                    }
                } footer: {
                    SectionFootnote("Versions, source status, session counts and recent log lines. No message text, titles, paths or ids.")
                }
                if SqueakMacApp.reportsEnabled {
                    Section {
                        Button("Report a problem…") { Heresay.present() }
                    } footer: {
                        SectionFootnote("Tell us what's broken, confusing or could be better. A person reads every report. Also in Help › Report a problem (⌥⌘R).")
                    }
                }
        }
        .formStyle(.grouped)
    }
}
