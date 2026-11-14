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
        VStack(spacing: 0) {
            Color.clear.frame(height: 44).background(WindowDragArea())   // the workbench's title area
            ScrollView {
                SettingsPage(section: model.settingsSection ?? .general)
            }
        }
        .squeakWindowCanvas()
        .scrollIndicators(.automatic)
    }
}

private extension SettingsSection {
    var symbol: LucideName {
        switch self {
        case .account: .users
        case .models: .sparkles
        case .messages: .messageSquare
        case .general: .settings
        case .service: .wrench
        case .notifications: .bell
        case .awake: .moon
        case .addons: .layers
        case .conductor, .rasanai: .layers
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
        case .general, .models: Theme.info
        case .account: Theme.success
        case .notifications, .awake: Theme.negative
        case .addons, .conductor, .rasanai, .connections, .messages, .service: Theme.success
        case .telegram, .cliq, .iphone, .voice: Color(red: 0.45, green: 0.62, blue: 1.0)
        case .privacy: Theme.muted
        case .about: Color(red: 0.72, green: 0.55, blue: 0.95)
        }
    }

    var subtitle: String {
        switch self {
        case .account: "Sign in to see this Mac from your browser and iPhone, and how it reaches Squeak's cloud."
        case .models: "The starting points for new threads, shared with your iPhone and the web."
        case .messages: "What a message does when the agent is already working."
        case .general: "Make Squeak feel right on this Mac."
        case .service: "The local connection that follows your sessions, and details for when you need a hand."
        case .notifications: "Choose what reaches you here and on your channels."
        case .awake: "Keep this Mac reachable while you’re away."
        case .addons: "Everything Squeak can work with, each added or removed the same way."
        case .conductor: "See and answer Conductor's chats from Squeak."
        case .rasanai: "Answer a RasanAI film's director from Squeak."
        case .connections: "See the services and channels Squeak can reach."
        case .telegram: "Send updates to a private Telegram chat."
        case .cliq: "Send updates and receive replies through Zoho Cliq."
        case .iphone: "The iPhones and browsers signed in to your account, and what they can do."
        case .voice: "Choose where Squeak rings when an agent is waiting for you."
        case .privacy: "Control what Squeak keeps on this Mac."
        case .about: "Version, credits, and project links."
        }
    }

    var searchAliases: [String] {
        switch self {
        case .account: ["sign in", "login", "email", "google", "zoho", "web", "browser", "cloud", "relay", "firebase", "catalyst", "server", "connect", "reconnect", "squeak"]
        case .models: ["model", "preset", "thinking", "effort", "plan first", "claude", "codex", "new thread"]
        case .messages: ["send", "sending", "queue", "steer"]
        case .general: ["general", "shortcut", "hotkey", "floating duck", "login", "launch", "quick message"]
        case .service: ["daemon", "diagnostics", "status", "hooks", "ready", "log"]
        case .notifications: ["alerts", "banners", "push"]
        case .awake: ["sleep", "power", "lid", "keep mac awake"]
        case .addons: ["extension", "add-on", "addon", "integration", "plugin", "conductor", "rasanai", "telegram", "cliq", "calls", "workspace", "project", "agent"]
        case .conductor: ["workspace", "project", "agent", "extension"]
        case .rasanai: ["film", "director", "extension"]
        case .connections: ["status", "connection"]
        case .telegram: ["channel", "bot"]
        case .cliq: ["zoho", "channel", "bot"]
        case .iphone: ["phone", "iphone", "browser", "web", "mobile", "device", "remove", "approve"]
        case .voice: ["call", "ring", "phone"]
        case .privacy: ["cache", "messages", "data", "delete"]
        case .about: ["version", "credits", "updates", "update", "feedback", "uninstall", "remove"]
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
            .toggleStyle(.switch)
            // Native grouped Forms inset their sections by 20 points; cards use 24.
            .padding(.horizontal, 4)
            .squeakWindowCanvas()
    }
}

struct SettingSubsectionHeader: View {
    let title: String
    let symbol: String
    var color: Color = Theme.success

    var body: some View {
        Label {
            Text(title).foregroundStyle(Theme.ink)
        } icon: {
            Image(systemName: symbol).foregroundStyle(color)
        }
        .font(Typo.heading)
        .padding(.vertical, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

struct SettingsSidebar: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @FocusState private var focusedSection: SettingsSection?
    @State private var query = ""

    private var filteredGroups: [(group: SettingsSection.Group, sections: [SettingsSection])] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        let shown = model.extensionSections
        let groups = SettingsSection.titledGroups.map { group in
            (group, group == .extensions ? group.sections.filter { shown.contains($0) } : group.sections)
        }
        guard !terms.isEmpty else { return groups.filter { !$0.1.isEmpty } }
        return groups.compactMap { group, sections in
            let matches = sections.filter { section in
                let haystack = ([section.title, section.subtitle] + section.searchAliases).joined(separator: " ").localizedLowercase
                return terms.allSatisfy { haystack.contains($0.localizedLowercase) }
            }
            return matches.isEmpty ? nil : (group, matches)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Traffic-light clearance in a window; a short gap in full screen. Search leads, as the conversation sidebar's first item does.
            Color.clear.frame(height: model.conversationFullScreen ? Space.m : 40).background(WindowDragArea())
            SidebarSearchField(prompt: "Search settings…", text: $query, focused: $searchFocused, accessibilityLabel: "Search settings")
                .onSubmit { if let first = filteredGroups.first?.sections.first { model.settingsSection = first } }
                .padding(.horizontal, Space.s).padding(.bottom, Space.m)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if query.isEmpty { SetupCardView().padding(.bottom, Space.xs) }
                    ForEach(filteredGroups, id: \.group.id) { entry in
                        SettingsGroupHeader(title: entry.group.title)
                        ForEach(entry.sections) { section in row(section) }
                    }
                    if filteredGroups.isEmpty {
                        Text("No settings found").font(.system(size: 15)).foregroundStyle(Theme.muted)
                            .padding(.horizontal, Space.l).padding(.vertical, 10)
                            .accessibilityLabel("No settings match \(query)")
                    }
                }
                .padding(.horizontal, Space.s).padding(.bottom, Space.m)
            }
            .scrollContentBackground(.hidden)
            .onMoveCommand(perform: moveFocus)
            .task { await model.refreshExtensions() }
            VStack(spacing: 0) {
                Rectangle().fill(Theme.line).frame(height: 1)
                SidebarNavRow(icon: .chevronLeft, title: "Back to sessions") { model.closeSettings() }
                    .padding(.horizontal, Space.s).padding(.vertical, 8)
                    .help("Back to sessions (Esc)")
            }
        }
        .frame(width: Metrics.workbenchSidebar)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
        .background {
            Button("Search Settings") { searchFocused = true }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
        }
    }

    private func row(_ section: SettingsSection) -> some View {
        SidebarNavRow(title: section.title, selected: model.settingsSection == section, action: { model.settingsSection = section }) {
            switch section {
            case .telegram: ServiceMark(service: .telegram, size: 20)
            case .cliq: ServiceMark(service: .cliq, size: 20)
            default: Lucide(section.symbol, size: 17, color: Theme.muted)
            }
        }
        .focused($focusedSection, equals: section)
        .accessibilityLabel(section.title)
        .help(section.title)
    }

    private func moveFocus(_ direction: MoveCommandDirection) {
        let sections = filteredGroups.flatMap { $0.sections }
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

/// A group's label in the Settings sidebar: DESIGN.md's section label, in line with the rows' icon column, more room above than below.
private struct SettingsGroupHeader: View {
    let title: String
    var body: some View {
        Text(title).font(Typo.label).foregroundStyle(Theme.muted)
            .padding(.horizontal, Space.s + 2).padding(.top, Space.l).padding(.bottom, Space.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A small ring of how many first-run steps are done, in the accent (never a state colour).
private struct SetupProgressRing: View {
    let done: Int
    let total: Int
    var body: some View {
        ZStack {
            Circle().stroke(Theme.line, lineWidth: 2.5)
            Circle().trim(from: 0, to: SetupCard.fraction(done: done, total: total))
                .stroke(Theme.duck, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18).frame(width: 20)
        .animation(Motion.standard, value: done)
        .accessibilityHidden(true)
    }
}

/// "Finish setting up": the first-run steps still to do, at the top of the Settings sidebar. It leaves when none is left.
private struct SetupCardView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let remaining = SetupCard.remaining(model.setupFlow)
        if !remaining.isEmpty {
            @Bindable var model = model
            let progress = SetupCard.progress(model.setupFlow)
            VStack(alignment: .leading, spacing: Space.s) {
                Button { withAnimation(Motion.quick) { model.setupCardExpanded.toggle() } } label: {
                    HStack(spacing: 12) {
                        SetupProgressRing(done: progress.done, total: progress.total)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Finish setting up").font(Typo.label).foregroundStyle(Theme.ink)
                            Text(SetupCard.subtitle(left: remaining.count)).font(Typo.meta).foregroundStyle(Theme.muted)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted)
                            .rotationEffect(.degrees(model.setupCardExpanded ? 90 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Finish setting up, \(progress.done) of \(progress.total) done, \(SetupCard.subtitle(left: remaining.count))")
                .accessibilityHint(model.setupCardExpanded ? "Collapse" : "Expand")
                if model.setupCardExpanded {
                    ForEach(remaining) { stage in
                        HStack(spacing: 8) {
                            Text(stage.title).font(Typo.body).foregroundStyle(Theme.ink)
                            Spacer(minLength: 0)
                            Button("Set up") {
                                model.unskipSetupStage(stage)
                                OnboardingController.shared.show(at: stage)
                            }
                            .buttonStyle(SecondaryButtonStyle())
                            .accessibilityLabel("Set up \(stage.title)")
                        }
                    }
                }
            }
            .padding(.horizontal, Space.s + 2).padding(.vertical, Space.s + 2)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line) }
            .task { await model.setup.poll(model) }
        }
    }
}

/// One page: its title, then the form. Capped in width so rows stay readable in a wide window.
private struct SettingsPage: View {
    let section: SettingsSection

    var body: some View {
        VStack(alignment: .center, spacing: 0) {
            HStack(alignment: .center, spacing: Space.m) {
                Group {
                    switch section {
                    case .telegram: ServiceMark(service: .telegram, size: 26)
                    case .cliq: ServiceMark(service: .cliq, size: 26)
                    default: Lucide(section.symbol, size: 18, color: section.headerColor)
                    }
                }
                    .frame(width: 38, height: 38)
                    .background(section.headerColor.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.control))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(section.title).font(Typo.title).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                    Text(section.subtitle).font(Typo.body).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 16)
            page
        }
        // Constrain the whole page once, so title and content receive the same width.
        // Capping the title before padding makes it 48 points wider than the cards.
        .frame(maxWidth: 680)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .id(section)
        .screen("Settings: \(section.title)")
    }

    @ViewBuilder private var page: some View {
        switch section {
        case .account: AccountSettings()
        case .models: ModelsSettings()
        case .messages: MessagesSettings()
        case .general: GeneralSettings()
        case .service: ServiceSettings()
        case .notifications: NotificationsSettings()
        case .awake: AwakeSettings()
        case .addons: AddonsSettings()
        case .conductor: ExtensionPageView(id: "conductor")
        case .rasanai: ExtensionPageView(id: "rasanai")
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
/// "When the agent is working, Send…": the daemon's shared queue/steer default, also used by the phone.
private struct SendDefaultPicker: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SqueakPicker("When the agent is working, Send…", selection: Binding(
                    get: { model.sendDefault.mode }, set: { mode in Task { await model.setSendDefault(mode) } }
                )) {
                    SqueakChoice(title: "Queue it", value: SendMode.queue)
                    SqueakChoice(title: "Steer it", value: SendMode.steer)
                }
                .disabled(model.sendDefaultLoad != .ready)
                if model.sendDefaultLoad == .loading { ProgressView().controlSize(.small) }
            }
            switch model.sendDefaultLoad {
            case .loading: SectionFootnote("Reading it from Squeak…")
            case .unavailable(let why): SectionFootnote(why)
            case .ready: SectionFootnote("Queue waits for the turn to end. Steer goes into the turn in progress. The Send button follows this; the keys are fixed: ↵ queues and ⌘↵ steers while the agent works.")
            }
        }
        .task { await model.loadSendDefault() }
    }
}

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
                VStack(alignment: .leading, spacing: 22) {
                    SettingsCard(title: "On this Mac", subtitle: "A timely nudge when your attention can move work forward.", symbol: "bell.badge") {
                        Toggle(isOn: $model.notificationsEnabled) {
                            Text("Session alerts").font(Typo.label).frame(maxWidth: .infinity, alignment: .leading)
                        }
                            .disabled(!Bundled.isApp)
                        if model.notificationsEnabled, bannersShown == false {
                            PermissionExplainer(kind: .notifications)
                        }
                        SectionFootnote("Approvals, questions, plans to review, errors, and finished chats you can reply to. Reply to a finished chat from the notification itself.")
                    }
                    ForEach(NotifyChannel.allCases, id: \.self) { NotificationsSection(channel: $0) }
                    if model.channels.notify?.shown.isEmpty ?? true {
                        SettingsCard(title: "Take updates with you", subtitle: "Connect a channel to choose which moments reach you away from this Mac.", symbol: "paperplane") {
                            HStack {
                                Button("Set up Telegram") { model.settingsSection = .telegram }.buttonStyle(SecondaryButtonStyle())
                                Button("Set up Zoho Cliq") { model.settingsSection = .cliq }.buttonStyle(SecondaryButtonStyle())
                            }
                        }
                    }
                }
                .toggleStyle(.switch)
                .padding(.horizontal, 24)
                .padding(.bottom, 28)
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
    private let hotKeys = HotKeyCenter.shared
    private let floatingDuck = FloatingDuckController.shared
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String?

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Always close by", subtitle: "Choose how Squeak fits into your day.", symbol: "sun.max") {
                Toggle(isOn: Binding(
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
                )) {
                    SettingsControlLabel(title: "Open at login", detail: "Have Squeak ready when you sign in to this Mac.")
                }
                .disabled(!Bundled.isApp)
                if let loginError { SectionFootnote(loginError) }
                else if !Bundled.isApp { SectionFootnote("Available when running the Squeak app, not from a build folder.") }
                Divider().overlay(Theme.line)
                Toggle(isOn: Binding(
                    get: { floatingDuck.isEnabled },
                    set: { floatingDuck.setEnabled($0) }
                )) {
                    SettingsControlLabel(title: "Floating duck", detail: "A movable shortcut to your sessions, across every Space.")
                }
                .disabled(model.captureMode || model.demoMode)
                LabeledContent("Show or hide duck", value: "⌃⌥ H")
                if let error = hotKeys.duckShortcutError { SectionFootnote(error) }
            }
            SettingsCard(title: "Disk", subtitle: "Streams leave folders and branches behind. See them with their sizes and clean up what is safe.", symbol: "internaldrive") {
                Button("Clean up disk\u{2026}") { DiskCleanupCenter.shared.open() }.buttonStyle(SecondaryButtonStyle())
                SectionFootnote("Folders go to the Trash, never straight to deletion. Anything with unsaved work is left unticked.")
            }
            SettingsCard(title: "Quick message", subtitle: "Reach a session from any app, without losing your place.", symbol: "keyboard") {
                SqueakPicker("Keyboard shortcut", selection: Binding(get: { model.hotKeyID ?? "" }, set: { model.hotKeyID = $0.isEmpty ? nil : $0 })) {
                    SqueakOptions(HotKeyPreset.all) { preset in
                        SqueakChoice(title: preset.title, value: preset.id).accessibilityLabel(preset.title)
                    }
                    SqueakChoice(title: "None", value: "")
                }
                if hotKeys.needsInputMonitoring {
                    PermissionExplainer(kind: .inputMonitoring, onGranted: { hotKeys.recheck() })
                }
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
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
    }


    static func openNotificationSettings() {
        let id = Bundle.main.bundleIdentifier ?? "com.squeak.mac"
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
            NSWorkspace.shared.open(url)
        }
    }
}

/// Settings › Agents › Models & presets: the thread presets every surface shares.
private struct ModelsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            chatPresetSettings
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
    }

    private var presetPreferences: ChatPresetPreferences { ChatPresetPreferences() }
    @State private var chatModels: [DaemonChatModel] = []
    /// Presets are shared by every surface and are Claude's: Codex threads keep their plain model picker.
    private let presetAgent: NewChatAgent = .claude
    @State private var presetRefresh = 0
    @State private var draftPresetNames: [String: String] = [:]
    @State private var expandedPresets: Set<ChatPreset> = []

    private var chatPresetSettings: some View {
        SettingsCard(title: "New thread presets", subtitle: "Three starting points that mix Claude models by role. Pick one when you start a thread.", symbol: "sparkles") {
            if chatModels.isEmpty {
                SectionFootnote("The models this Mac can use load once the Squeak service is running.")
            } else {
                ForEach([ChatPreset.best, .balanced, .save], id: \.self) { preset in
                    presetEditor(preset)
                }
            }
            SectionFootnote("Shared with your iPhone and the web through Squeak. Codex threads keep the plain model picker.")
        }
        .task {
            await model.syncChatPresets()
            draftPresetNames = [:]
            presetRefresh += 1
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
        return DisclosureGroup(isExpanded: Binding(
            get: { expandedPresets.contains(preset) },
            set: { if $0 { expandedPresets.insert(preset) } else { expandedPresets.remove(preset) } }
        )) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Customize this preset").font(Typo.label).foregroundStyle(Theme.muted)
                    Spacer()
                    Button("Restore defaults") {
                        preferences.restoreDefaults(for: preset, agent: presetAgent)
                        draftPresetNames[preset.rawValue] = preset.title
                        presetRefresh += 1
                    }
                    .buttonStyle(.link)
                    .accessibilityLabel("Restore \(preset.title) defaults")
                }
                LabeledContent("Name") {
                    TextField("Name shown in New chat", text: Binding(
                        get: { draftPresetNames[preset.rawValue] ?? preferences.title(for: preset) },
                        set: { draftPresetNames[preset.rawValue] = $0; preferences.setTitle($0, for: preset) }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Name shown in New chat")
                }
                if let initial {
                    VStack(alignment: .leading, spacing: 9) {
                        SqueakPicker("Plans and talks", selection: settingBinding(preset, initial: initial, keyPath: \.modelId)) {
                            SqueakOptions(list) { model in SqueakChoice(title: model.label, value: Optional(model.id)) }
                        }
                        if let selected = list.first(where: { $0.id == initial.modelId }), !selected.levels.isEmpty {
                            SqueakPicker("Thinking", selection: settingBinding(preset, initial: initial, keyPath: \.level)) {
                                SqueakOptions(selected.levels, id: \.self) { SqueakChoice(title: DaemonChatModel.levelName($0), value: Optional($0)) }
                            }
                        }
                        do {
                            SqueakPicker("Codes", selection: settingBinding(preset, initial: initial, keyPath: \.code)) {
                                SqueakChoice(title: "Same model", value: String?.none)
                                SqueakOptions(ChatWorker.all) { SqueakChoice(title: $0.label, value: Optional($0.id)) }
                            }
                            SqueakPicker("Runs commands", selection: settingBinding(preset, initial: initial, keyPath: \.run)) {
                                SqueakChoice(title: "Same model", value: String?.none)
                                SqueakOptions(ChatWorker.all) { SqueakChoice(title: $0.label, value: Optional($0.id)) }
                            }
                            Toggle(isOn: Binding(
                                get: { presetPreferences.setup(for: preset, agent: presetAgent, models: chatModels)?.planFirst ?? initial.planFirst },
                                set: { value in updateSetup(preset, initial: initial) { $0.planFirst = value && ($0.code != nil || $0.run != nil) } }
                            )) {
                                SettingsControlLabel(title: "Plan first", detail: "Review the plan before delegated work begins.")
                            }
                        }
                    }
                    .id(presetRefresh)
                }
            }
            .padding(.top, 16)
        } label: {
            ChatPresetSummary(preset: preset, name: preferences.title(for: preset), model: list.first(where: { $0.id == initial?.modelId })?.label)
        }
        .padding(16)
        .background(Theme.surfaceRaised.opacity(0.65), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line) }
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
}

/// Settings › Agents › Messages: what Send does while the agent works.
private struct MessagesSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Sending", subtitle: "What a message does when the agent is already working.", symbol: "paperplane") {
                SendDefaultPicker(model: model)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
    }
}

/// Settings › This Mac › Background service: how this Mac is connected, the service, and diagnostics.
private struct ServiceSettings: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false
    @State private var confirmRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            macCard
            SettingsCard(title: "Background service", subtitle: "The local connection that follows your sessions.", symbol: "gearshape.2") {
                    BackgroundServiceRow(daemon: model.daemon)
                    SectionFootnote(BackgroundServiceRow.footnote(model.daemon.status))
                }
            SettingsCard(title: "Diagnostics", subtitle: "Useful details when you need a hand.", symbol: "stethoscope") {
                    Button(copied ? "Copied" : "Copy diagnostics") {
                        model.copyDiagnostics()
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                    }
                    SectionFootnote("Versions, source status, session counts and recent log lines. No message text, titles, paths or ids.")
                }
            if let h = model.setup.hooks, h.state == .installed || h.state == .partial {
                Button("Remove agent hooks…") { confirmRemove = true }
                    .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await model.setup.poll(model) }
        .confirmationDialog("Remove Squeak's agent hooks?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { Task { await model.setup.uninstallHooks() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Squeak stops hearing when Claude Code and Codex are waiting for you. Your other settings are left alone.")
        }
    }

    private var macCard: some View {
        let r = model.connectionsReport
        return SettingsCard(title: "Ready on this Mac", subtitle: "Your local connection at a glance. Find more under Connections.", symbol: "desktopcomputer") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(r.addonRows.enumerated()), id: \.offset) { _, row in macRow(row.title, row) }
                macRow("Squeak service", r.daemon)
                macRow("Sending", r.sending)
            }
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
                                .foregroundStyle(Theme.success)
                                .frame(width: 30, height: 30)
                                .background(Theme.success.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Local connection").font(Typo.heading).foregroundStyle(Theme.ink)
                                Text("Squeak reads agent chats locally and only sends replies when you choose.")
                                    .font(Typo.body).foregroundStyle(Theme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        VStack(alignment: .leading, spacing: Space.m) {
                            ForEach(Array(r.addonRows.enumerated()), id: \.offset) { _, a in row(a, name: a.title, okWord: "Reading chats", okColor: Theme.success) }
                            row(r.daemon, name: "Squeak service", okWord: "Connected", okColor: Theme.success)
                            row(r.sending, name: "Sending", okWord: "Available", okColor: Theme.info)
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
            .padding(.horizontal, 24)
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
            case .working: Circle().fill(Theme.success).frame(width: 9, height: 9).accessibilityHidden(true)
            case .error: Circle().fill(Theme.negative).frame(width: 9, height: 9).accessibilityHidden(true)
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
        case .warning: Theme.negative
        case .problem: Theme.negative
        case .neutral: Theme.subtle
        }
    }
}

private struct PrivacySettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirm = false

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Notification privacy", subtitle: "Choose how much a glance at your screen reveals.", symbol: "eye.slash") {
                Toggle(isOn: $model.notificationsShowNames) {
                    Text("Show session names in notifications").font(Typo.label).frame(maxWidth: .infinity, alignment: .leading)
                }
                SectionFootnote("Off by default. With this off, notifications don't name the session. With it on, they also show what an agent is asking; never other message text.")
            }
            SettingsCard(title: "Crash and problem reports", subtitle: "What Squeak sends to be fixed.", symbol: "exclamationmark.bubble") {
                SectionFootnote("If Squeak crashes or a setup step fails, diagnostics are sent through Heresay automatically; anything else is sent only when you press Report and send it.")
            }
            SettingsCard(title: "Message cache", subtitle: "Your local history stays encrypted on this Mac.", symbol: "lock.shield") {
                SectionFootnote(model.cacheNotice ?? "Messages are encrypted on this Mac, kept 14 days, up to 50 MB.")
                Button("Purge cache…", role: .destructive) { confirm = true }
                    .buttonStyle(DestructiveButtonStyle())
            }
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .confirmationDialog("Delete the message cache and its encryption key?", isPresented: $confirm) {
            Button("Delete cache", role: .destructive) { Task { await model.purgeCache() } }
        } message: {
            Text("Drafts stored with it are deleted too. Nothing in the chat's own app changes.")
        }
    }
}

private struct AboutSettings: View {
    @Environment(AppModel.self) private var model
    @State private var uninstalling = false
    @State private var uninstallSize = CGSize(width: 500, height: 560)

    var body: some View {
        @Bindable var model = model
        ScrollViewReader { proxy in
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Made for your agents", subtitle: "A little duck that keeps work moving.", symbol: "heart") {
                VStack(spacing: 6) {
                    DuckMark(width: 56)
                    Text("Squeak").font(.title2.bold())
                    Text("Version \(AppModel.appVersion)").foregroundStyle(.secondary)
                    Text("A pager for your coding agents. Reads your sessions and lets you answer them.")
                        .multilineTextAlignment(.center).font(.callout).foregroundStyle(.secondary).frame(maxWidth: 320)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 8)
            }
                SettingsCard(title: "Keep Squeak up to date", subtitle: "Choose how new versions arrive on this Mac.", symbol: "arrow.triangle.2.circlepath") {
                    Toggle(isOn: Binding(get: { model.updater.automaticallyChecks }, set: { model.updater.automaticallyChecks = $0 })) {
                        Text("Automatically check for updates").frame(maxWidth: .infinity, alignment: .leading)
                    }
                        .disabled(!model.updater.isActive)
                    Toggle(isOn: $model.updateAlertsEnabled) {
                        Text("Tell me when an update is available").frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Toggle(isOn: Binding(get: { model.updater.automaticallyInstalls }, set: { model.updater.automaticallyInstalls = $0 })) {
                        Text("Download and install updates automatically").frame(maxWidth: .infinity, alignment: .leading)
                    }
                        .disabled(!model.updater.isActive)
                    UpdateBanner(updater: model.updater, style: .settings).id("updateCard")
                    if let note = model.updateNote { Text(note).foregroundStyle(.secondary) }
                    Button("Check for updates…") { model.updater.checkForUpdates() }
                    SectionFootnote("Squeak checks once a day, and installs a new version for you when you quit or relaunch it, then reopens what you had open. Nothing about your chats is sent.")
                }
                if SqueakMacApp.reportsEnabled {
                    SettingsCard(title: "Help make Squeak better", subtitle: "Your feedback reaches a person.", symbol: "bubble.left") {
                        Button("Report a problem…") { ReportRouter.shared.present() }
                        SectionFootnote("Tell us what's broken, confusing or could be better. A person reads every report. Also in Help › Report a problem (⌥⌘R).")
                    }
                }
                SettingsCard(title: "Remove Squeak", subtitle: "Review everything before removing it from this Mac.", symbol: "trash") {
                    Button("Uninstall Squeak…", role: .destructive) { uninstalling = true }
                    SectionFootnote("Hands any extension's app back, removes Squeak's service, hooks and files from this Mac. You see everything first.")
                }
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .background {
            UninstallPresentationSizeReader { uninstallSize = $0 }
                .frame(width: 0, height: 0)
        }
        .sheet(isPresented: $uninstalling) { UninstallSheet(availableSize: uninstallSize) }
        .onChange(of: model.updater.highlightTick) { _, _ in
            withAnimation { proxy.scrollTo("updateCard", anchor: .center) }
        }
        .onAppear {
            // Settings opened on this page by "Check for updates…": the card is what they came for.
            if Date().timeIntervalSince(model.updater.lastHighlight) < 2 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { withAnimation { proxy.scrollTo("updateCard", anchor: .center) } }
            }
        }
        }
    }
}
