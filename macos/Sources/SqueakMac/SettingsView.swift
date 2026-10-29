import AppKit
import Heresay
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The main NavigationSplitView owns the window chrome for both sessions and Settings.
/// This is only the detail content shown when the Settings sidebar is active.
struct SettingsDetail: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            SettingsPage(section: model.settingsSection ?? .general)
        }
        .squeakWindowCanvas()
        .scrollIndicators(.automatic)
    }
}

private extension SettingsSection {
    var symbol: LucideName {
        switch self {
        case .setup: .check
        case .general: .settings
        case .notifications: .bell
        case .awake: .moon
        case .conductor: .squareTerminal
        case .connections: .link
        case .telegram: .send
        case .cliq: .messageSquare
        case .iphone: .smartphone
        case .voice: .phone
        case .privacy: .hand
        case .about: .info
        }
    }

    var headerColor: Color {
        switch self {
        case .setup, .general: Theme.done
        case .notifications, .awake: Theme.needsYou
        case .conductor, .connections: Theme.working
        case .telegram, .cliq, .iphone, .voice: Color(red: 0.45, green: 0.62, blue: 1.0)
        case .privacy: Theme.muted
        case .about: Color(red: 0.72, green: 0.55, blue: 0.95)
        }
    }

    var subtitle: String {
        switch self {
        case .setup: "A quick path to a working Squeak setup."
        case .general: "Make Squeak feel right on this Mac."
        case .notifications: "Choose what reaches you here and on your channels."
        case .awake: "Keep this Mac reachable while you’re away."
        case .conductor: "Connect Squeak to your Conductor workspace."
        case .connections: "See the services and channels Squeak can reach."
        case .telegram: "Send updates to a private Telegram chat."
        case .cliq: "Send updates and receive replies through Zoho Cliq."
        case .iphone: "Pair a phone to follow sessions and reply on the go."
        case .voice: "Choose where Squeak rings when an agent needs you."
        case .privacy: "Control what Squeak keeps on this Mac."
        case .about: "Version, credits, and project links."
        }
    }

    var searchAliases: [String] {
        switch self {
        case .setup: ["welcome", "onboarding"]
        case .general: ["general", "shortcut", "hotkey", "floating duck", "login", "launch", "update"]
        case .notifications: ["alerts", "banners", "push"]
        case .awake: ["sleep", "power", "lid", "keep mac awake"]
        case .conductor: ["workspace", "project", "agent", "conductor workspace"]
        case .connections: ["status", "connection", "service", "diagnostics"]
        case .telegram: ["channel", "bot"]
        case .cliq: ["zoho", "channel", "bot"]
        case .iphone: ["phone", "pair", "mobile"]
        case .voice: ["call", "ring", "phone"]
        case .privacy: ["cache", "messages", "data", "delete"]
        case .about: ["version", "credits", "updates"]
        }
    }
}

extension View {
    /// Keep the page on the app canvas while retaining native Form controls and section behavior.
    func settingsForm() -> some View {
        modifier(SettingsFormPresentation())
    }
}

private struct SettingsFormPresentation: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .formStyle(.grouped)
            .squeakWindowCanvas()
    }
}

struct SettingSubsectionHeader: View {
    let title: String
    let symbol: String
    var color: Color = Theme.working

    var body: some View {
        Label {
            Text(title).foregroundStyle(Theme.ink)
        } icon: {
            Image(systemName: symbol).foregroundStyle(color)
        }
        .font(Typo.label)
        .accessibilityAddTraits(.isHeader)
    }
}

struct SettingsSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var isCollapsed: Bool
    @FocusState private var searchFocused: Bool
    @FocusState private var focusedSection: SettingsSection?
    @State private var query = ""

    private var filteredGroups: [[SettingsSection]] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !terms.isEmpty else { return SettingsSection.groups }
        return SettingsSection.groups.compactMap { group in
            let matches = group.filter { section in
                let haystack = ([section.title, section.subtitle] + section.searchAliases).joined(separator: " ").localizedLowercase
                return terms.allSatisfy { haystack.contains($0.localizedLowercase) }
            }
            return matches.isEmpty ? nil : matches
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand
            if !isCollapsed {
                searchField
                    .padding(.horizontal, Metrics.sidebarInset)
                    .padding(.top, 14)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.sidebarRowGap) {
                    ForEach(Array(filteredGroups.enumerated()), id: \.offset) { _, group in
                        ForEach(group) { section in
                            row(section)
                        }
                    }
                    if filteredGroups.isEmpty {
                        Text("No settings found")
                            .font(.system(size: Metrics.sidebarText))
                            .foregroundStyle(Theme.muted)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .accessibilityLabel("No settings match \(query)")
                    }
                }
                .padding(.horizontal, isCollapsed ? 8 : Metrics.sidebarInset)
                .padding(.top, 14)
            }
            .scrollContentBackground(.hidden)
            .onMoveCommand(perform: moveFocus)
            footer
        }
        // A fixed fitting width lets NavigationSplitView honor the icon rail after the
        // collapsed state changes, instead of retaining the expanded sidebar's width.
        .frame(width: isCollapsed ? 64 : Metrics.sidebarWidth, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
        .background {
            SidebarColumnSizer(
                isCollapsed: isCollapsed,
                expandedMinimum: 200,
                expandedIdeal: 216,
                expandedMaximum: 280
            )
            .frame(width: 0, height: 0)
        }
        .background {
            Button("Search Settings") { searchFocused = true }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
        }
    }

    private var brand: some View {
        HStack {
            if !isCollapsed {
                Text("Settings")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
            }
            if !isCollapsed { Spacer(minLength: 0) }
            SidebarCollapseButton(isCollapsed: $isCollapsed)
        }
        .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
        .padding(.horizontal, isCollapsed ? 16 : Metrics.sidebarInset + 4)
        .padding(.top, 36)
    }

    private var searchField: some View {
        SidebarSearchField(prompt: "Search settings…", text: $query, focused: $searchFocused, accessibilityLabel: "Search settings")
            .onSubmit { if let first = filteredGroups.first?.first { model.settingsSection = first } }
    }

    private func row(_ section: SettingsSection) -> some View {
        let selected = model.settingsSection == section
        return Button {
            model.settingsSection = section
        } label: {
            HStack(spacing: 12) {
                Lucide(section.symbol, size: Metrics.sidebarIcon, color: selected ? Theme.working : Theme.muted)
                    .frame(width: 20)
                if !isCollapsed {
                    Text(verbatim: section.title)
                        .font(.system(size: Metrics.sidebarText, weight: selected ? .medium : .regular))
                        .foregroundStyle(Theme.ink)
                    Spacer(minLength: 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
            .padding(.horizontal, isCollapsed ? 0 : 12)
            .frame(height: Metrics.navRow)
            .background(RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous).fill(selected ? Color.white.opacity(0.10) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focusedSection, equals: section)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(section.title)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, Metrics.sidebarInset)
            Button { model.closeSettings() } label: {
                HStack(spacing: 12) {
                    Lucide(.chevronLeft, size: Metrics.sidebarIcon, color: Theme.muted).frame(width: 20)
                    if !isCollapsed { Text("Back to sessions").font(.system(size: Metrics.sidebarText)).foregroundStyle(Theme.ink); Spacer(minLength: 0) }
                }
                .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
                .padding(.horizontal, isCollapsed ? 0 : 12).frame(height: Metrics.navRow).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, isCollapsed ? 8 : Metrics.sidebarInset)
            .padding(.vertical, 12)
            .help("Back to sessions (Esc)")
            .accessibilityLabel("Back to sessions")
        }
    }

    private func moveFocus(_ direction: MoveCommandDirection) {
        let sections = filteredGroups.flatMap { $0 }
        guard !sections.isEmpty else { return }
        let current = focusedSection ?? model.settingsSection
        let index = current.flatMap(sections.firstIndex(of:))
        let next: SettingsSection
        switch direction {
        case .up: next = index.map { sections[max($0 - 1, 0)] } ?? sections.last!
        case .down: next = index.map { sections[min($0 + 1, sections.count - 1)] } ?? sections.first!
        default: return
        }
        self.focusedSection = next
        model.settingsSection = next
    }
}

/// One page: its title, then the form. Capped in width so rows stay readable in a wide window.
private struct SettingsPage: View {
    let section: SettingsSection

    var body: some View {
        VStack(alignment: .center, spacing: 0) {
            HStack(alignment: .center, spacing: Space.m) {
                Lucide(section.symbol, size: 18, color: section.headerColor)
                    .frame(width: 38, height: 38)
                    .background(section.headerColor.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.control))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(section.title).font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                    Text(section.subtitle).font(Typo.body).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: 680, alignment: .leading)
            .padding(.leading, 61).padding(.trailing, 24).padding(.top, 18).padding(.bottom, 16)
            page.frame(maxWidth: 680)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .id(section)
    }

    @ViewBuilder private var page: some View {
        switch section {
        case .setup: SetupSettings()
        case .general: GeneralSettings()
        case .notifications: NotificationsSettings()
        case .awake: AwakeSettings()
        case .conductor: ConductorSettings()
        case .connections: ConnectionsSettings()
        case .telegram: TelegramSettings()
        case .cliq: CliqSettings()
        case .iphone: IPhoneSettings()
        case .voice: VoiceSettingsPage()
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
struct NotificationsSettings: View {
    @Environment(AppModel.self) private var model
    @State private var bannersShown: Bool?

    var body: some View {
        Group {
            do {
                @Bindable var model = model
                Form {
                    Section {
                        Toggle("Notify me on this Mac when a session needs me or finishes", isOn: $model.notificationsEnabled)
                            .disabled(!Bundled.isApp)
                        if model.notificationsEnabled, bannersShown == false {
                            PermissionExplainer(kind: .notifications)
                        }
                    } footer: {
                        SectionFootnote("Approvals, questions, plans to review, errors, and finished Conductor chats. Reply to a finished chat from the notification itself.")
                    }
                    ForEach(NotifyChannel.allCases, id: \.self) { NotificationsSection(channel: $0) }
                    if model.channels.notify?.shown.isEmpty ?? true {
                        Section { SectionFootnote("Set up Telegram or Zoho Cliq to choose what each one pushes.") }
                    }
                }
                .settingsForm()
            }
        }
        .task { bannersShown = await Notifier.shared.bannersShown(); await model.channels.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { bannersShown = await Notifier.shared.bannersShown() }
        }
    }
}

struct GeneralSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(WindowAppearancePreference.key) private var glassWindowAppearance = true
    @AppStorage(WindowAppearancePreference.transparencyKey) private var glassTransparency = WindowAppearancePreference.defaultTransparency
    @AppStorage(WindowAppearancePreference.sidebarContrastKey) private var glassSidebarContrast = WindowAppearancePreference.defaultSidebarContrast
    private let hotKeys = HotKeyCenter.shared
    private let floatingDuck = FloatingDuckController.shared
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String?

    var body: some View {
        @Bindable var model = model
        Form {
            macCard
            chatPresetSettings
            Section {
                Picker("Style", selection: $glassWindowAppearance) {
                    Text("Glass").tag(true)
                    Text("Solid").tag(false)
                }
                .pickerStyle(.segmented)
                LabeledContent("Glass transparency", value: "\(Int(glassTransparency.rounded()))%")
                Slider(value: $glassTransparency, in: 0...100, step: 1)
                    .accessibilityLabel("Glass transparency")
                    .accessibilityValue("\(Int(glassTransparency.rounded())) percent")
                    .disabled(!glassWindowAppearance || reduceTransparency)
                LabeledContent("Sidebar contrast", value: "\(Int(glassSidebarContrast.rounded()))%")
                Slider(value: $glassSidebarContrast, in: 0...100, step: 1)
                    .accessibilityLabel("Sidebar contrast")
                    .accessibilityValue("\(Int(glassSidebarContrast.rounded())) percent")
                    .disabled(!glassWindowAppearance || reduceTransparency)
            } header: {
                Text("Window appearance")
            } footer: {
                SectionFootnote(appearanceFootnote)
            }
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
                Toggle("Show the floating duck", isOn: Binding(
                    get: { floatingDuck.isEnabled },
                    set: { floatingDuck.setEnabled($0) }
                ))
                .disabled(model.captureMode || model.demoMode)
                LabeledContent("Show or hide duck", value: "⌃⌥ H")
                if let error = hotKeys.duckShortcutError {
                    SectionFootnote(error)
                }
            } footer: {
                SectionFootnote("Drag the duck anywhere on your screen. It follows you between Spaces; click it to open Squeak's session menu. The shortcut needs no permission.")
            }
            Section {
                Picker("Quick message shortcut", selection: Binding(get: { model.hotKeyID ?? "" }, set: { model.hotKeyID = $0.isEmpty ? nil : $0 })) {
                    ForEach(HotKeyPreset.all) { preset in
                        Text(preset.title).tag(preset.id).accessibilityLabel(preset.title)
                    }
                    Text("None").tag("")
                }
                if hotKeys.needsInputMonitoring {
                    PermissionExplainer(kind: .inputMonitoring, onGranted: { hotKeys.recheck() })
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
        .settingsForm()
    }

    private var appearanceFootnote: String {
        if reduceTransparency {
            return "Reduce Transparency is on in Accessibility, so Squeak uses the solid appearance. Glass controls are unavailable until it’s turned off."
        }
        if !glassWindowAppearance {
            return "Glass controls are unavailable while Solid is selected. Glass uses the native macOS window material when enabled."
        }
        return "Glass uses native macOS material with a subtle tint. Higher transparency reveals more of the material; sidebar contrast sets how much more opaque the sidebar feels than the main area. Reduce Transparency automatically switches to Solid."
    }

    private var presetPreferences: ChatPresetPreferences { ChatPresetPreferences() }
    @State private var chatModels: [DaemonChatModel] = []
    @State private var presetAgent: NewChatAgent = .claude
    @State private var presetRefresh = 0
    @State private var draftPresetNames: [String: String] = [:]

    private var chatPresetSettings: some View {
        Section {
            Picker("Agent", selection: $presetAgent) {
                ForEach(NewChatAgent.allCases) { agent in Text(agent.displayName).tag(agent) }
            }.pickerStyle(.segmented)
            if chatModels.isEmpty {
                SectionFootnote("Connect Conductor to load the models this Mac can use.")
            } else {
                ForEach([ChatPreset.best, .balanced, .save], id: \.self) { preset in
                    presetEditor(preset)
                }
            }
        } header: { Text("New chat presets") } footer: {
            SectionFootnote("Preset names and settings are saved on this Mac. Each agent has its own model choices.")
        }
        .task {
            chatModels = await model.newChatModels()
            for preset in [ChatPreset.best, .balanced, .save] where draftPresetNames[preset.rawValue] == nil {
                draftPresetNames[preset.rawValue] = presetPreferences.title(for: preset)
            }
        }
    }

    private func presetEditor(_ preset: ChatPreset) -> some View {
        let list = ChatPresets.models(chatModels, presetAgent)
        let preferences = presetPreferences
        let initial = preferences.setup(for: preset, agent: presetAgent, models: chatModels)
            ?? ChatPresets.setup(for: preset, agent: presetAgent, models: chatModels)
            ?? ChatPresets.setup(for: .best, agent: presetAgent, models: chatModels)
        return VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(preset.title).font(.headline)
                Spacer()
                Button("Restore defaults") {
                    preferences.restoreDefaults(for: preset, agent: presetAgent)
                    draftPresetNames[preset.rawValue] = preset.title
                    presetRefresh += 1
                }
                .buttonStyle(.link)
                .accessibilityLabel("Restore \(preset.title) defaults")
            }
            TextField("Name shown in New chat", text: Binding(
                get: { draftPresetNames[preset.rawValue] ?? preferences.title(for: preset) },
                set: { draftPresetNames[preset.rawValue] = $0; preferences.setTitle($0, for: preset) }
            ))
            if let initial {
                VStack(alignment: .leading, spacing: 9) {
                    Picker("Model", selection: settingBinding(preset, initial: initial, keyPath: \.modelId)) {
                        ForEach(list) { model in Text(model.label).tag(Optional(model.id)) }
                    }
                    if let selected = list.first(where: { $0.id == initial.modelId }), !selected.levels.isEmpty {
                        Picker("Thinking", selection: settingBinding(preset, initial: initial, keyPath: \.level)) {
                            ForEach(selected.levels, id: \.self) { Text(DaemonChatModel.levelName($0)).tag(Optional($0)) }
                        }
                    }
                    if presetAgent == .claude {
                        Picker("Code", selection: settingBinding(preset, initial: initial, keyPath: \.code)) {
                            Text("Same model").tag(String?.none)
                            ForEach(ChatWorker.all) { Text($0.label).tag(Optional($0.id)) }
                        }
                        Picker("Run commands", selection: settingBinding(preset, initial: initial, keyPath: \.run)) {
                            Text("Same model").tag(String?.none)
                            ForEach(ChatWorker.all) { Text($0.label).tag(Optional($0.id)) }
                        }
                        Toggle("Ask before changes", isOn: Binding(
                            get: { presetPreferences.setup(for: preset, agent: presetAgent, models: chatModels)?.planFirst ?? initial.planFirst },
                            set: { value in updateSetup(preset, initial: initial) { $0.planFirst = value && ($0.code != nil || $0.run != nil) } }
                        ))
                    }
                }
                .id(presetRefresh)
            }
        }
        .padding(.vertical, 4)
    }

    private func settingBinding<Value>(_ preset: ChatPreset, initial: ChatSetup, keyPath: WritableKeyPath<ChatSetup, Value>) -> Binding<Value> {
        Binding(get: { presetPreferences.setup(for: preset, agent: presetAgent, models: chatModels).map { $0[keyPath: keyPath] } ?? initial[keyPath: keyPath] }, set: { value in
            updateSetup(preset, initial: initial) { $0[keyPath: keyPath] = value }
        })
    }

    private func updateSetup(_ preset: ChatPreset, initial: ChatSetup, mutate: (inout ChatSetup) -> Void) {
        var setup = presetPreferences.setup(for: preset, agent: presetAgent, models: chatModels) ?? initial
        mutate(&setup)
        presetPreferences.setSetup(setup, for: preset, agent: presetAgent, models: chatModels)
        presetRefresh += 1
    }

    private var macCard: some View {
        let r = model.connectionsReport
        return Section {
            VStack(alignment: .leading, spacing: Space.s) {
                macRow("Conductor", r.database)
                macRow("Squeak service", r.daemon)
                macRow("Sending", r.sending)
            }
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
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                Card {
                    VStack(alignment: .leading, spacing: Space.m) {
                        HStack(spacing: Space.s) {
                            Image(systemName: "point.3.connected.trianglepath.dotted")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Theme.working)
                                .frame(width: 30, height: 30)
                                .background(Theme.working.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Local connection").font(Typo.heading).foregroundStyle(Theme.ink)
                                Text("Squeak reads agent chats locally and only sends replies when you choose.")
                                    .font(Typo.body).foregroundStyle(Theme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        VStack(alignment: .leading, spacing: Space.m) {
                            row(r.database, name: "Conductor", okWord: "Reading chats", okColor: Theme.working)
                            row(r.daemon, name: "Squeak service", okWord: "Connected", okColor: Theme.working)
                            row(r.sending, name: "Sending", okWord: "Available", okColor: Theme.done)
                        }
                        .padding(.top, Space.xs)
                    }
                }

                VStack(alignment: .leading, spacing: Space.s) {
                    SectionLabel("Channels")
                    Card {
                        VStack(alignment: .leading, spacing: Space.m) {
                            ForEach(model.channels.summary) { channelRow($0) }
                        }
                    }
                    Text("Manage Telegram, Zoho Cliq and iPhone in Settings.")
                        .font(.callout).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, Space.xs)
                }

                VStack(alignment: .leading, spacing: Space.s) {
                    SectionLabel("Service details")
                    Card {
                        VStack(alignment: .leading, spacing: Space.m) {
                            detailRow("Address", value: model.client.baseURL.absoluteString, selectable: true)
                            if let synced = model.lastSyncedText { detailRow("Last sync", value: synced) }
                            HStack {
                                Button("Check again") { model.recheck() }.buttonStyle(SecondaryButtonStyle())
                                Spacer()
                            }
                            if let help = model.connectionHelp {
                                Text(help).font(.callout).foregroundStyle(Theme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, Space.xxl)
        }
        .scrollIndicators(.automatic)
        .task { await model.channels.refresh() }
    }

    private func detailRow(_ title: String, value: String, selectable: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.l) {
            Text(title).font(Typo.body).foregroundStyle(Theme.ink)
            Spacer(minLength: Space.s)
            valueText(value, selectable: selectable)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func valueText(_ value: String, selectable: Bool) -> some View {
        if selectable {
            Text(verbatim: value).font(Typo.body).foregroundStyle(Theme.muted)
                .textSelection(.enabled).multilineTextAlignment(.trailing)
        } else {
            Text(verbatim: value).font(Typo.body).foregroundStyle(Theme.muted)
                .multilineTextAlignment(.trailing)
        }
    }

    private func channelRow(_ r: ChannelsModel.SummaryRow) -> some View {
        HStack(spacing: 12) {
            // Only a real state gets a dot (§3.3); "not set up" and "one-way" are plain text.
            switch r.dot {
            case .working: Circle().fill(Theme.working).frame(width: 9, height: 9).accessibilityHidden(true)
            case .error: Circle().fill(Theme.error).frame(width: 9, height: 9).accessibilityHidden(true)
            case .none: EmptyView()
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(r.name).font(Typo.label).foregroundStyle(Theme.ink)
                Text(r.value).font(Typo.body).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func row(_ r: ConnectionsReport.Row, name: String, okWord: String, okColor: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(color(r.level, ok: okColor)).frame(width: 9, height: 9)
                .padding(.top, 5)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(Typo.label).foregroundStyle(Theme.ink)
                Text(r.level == .ok ? okWord : r.value)
                    .font(Typo.body).foregroundStyle(Theme.muted)
                if let d = r.detail, r.level != .ok {
                    Text(d).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
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
        .settingsForm()
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
    @State private var uninstalling = false

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
                Section {
                    Button("Uninstall Squeak…", role: .destructive) { uninstalling = true }
                } footer: {
                    SectionFootnote("Hands Conductor back, removes Squeak's service, hooks and files from this Mac. You see everything first.")
                }
        }
        .settingsForm()
        .sheet(isPresented: $uninstalling) { UninstallSheet() }
    }
}
