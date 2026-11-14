import AppKit
import Observation
import SqueakMacAddons
import SqueakMacCore
import SwiftUI

enum SessionFilter: Hashable {
    case all
    case provider(String)
    case repo(String)
}

/// The sidebar's filters: sections of the list, or where a session runs.
enum NavFilter: Hashable {
    case home, all, needsYou, working, done
    case source(SessionSource)
    /// Not a list of sessions: opens the usage view in the detail column.
    case usage
}

/// The UI's single source of truth. The Broker (an actor) owns the data; this
/// mirrors what the screens draw and forwards what the user does.
@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    // MARK: Wiring
    let client: DaemonClient
    /// The after-setup tip in the menu-bar panel (TipsModel.swift).
    let tips: TipsModel
    /// A permission the explainer sheet is showing over the conversation window (a tip opened it).
    var permissionSheet: PermissionKind?
    let broker: Broker
    /// Squeak's own chats: the session host's client and controls (AppModel+Native.swift).
    @ObservationIgnored lazy var nativeHost = NativeHostClient.beside(client)
    @ObservationIgnored lazy var nativeAdapter = NativeAdapter(host: nativeHost, daemon: client)
    let native = NativeChatModel()
    /// The hottest state, one store each (AppStores.swift); the properties below forward to them.
    let awakeStore = AwakeStore()
    let usageStore = UsageStore()
    let chatStore = OpenChatStore()
    let cache: EncryptedCache?
    let captureMode: Bool
    /// SQUEAK_MAC_DEMO=1: made-up sessions, no network, no sends (see DemoData.swift).
    let demoMode: Bool
    /// Settings › Channels and › iPhone. Demo and capture runs never touch the real `.env` or daemon.
    @ObservationIgnored lazy var channels = ChannelsModel(client: client, demo: demoMode || captureMode)
    @ObservationIgnored lazy var account: AccountModel = {
        let a = AccountModel(client: client, demo: demoMode || captureMode)
        a.onChanged = { [weak self] in
            await self?.channels.refreshRemote()
            // Signing in is the cloud setup: once an account is linked, ask the daemon to connect.
            if await self?.account.email != nil { await self?.cloud.connect() }
        }
        return a
    }()
    @ObservationIgnored lazy var cloud = CloudModel(client: client, demo: demoMode || captureMode)
    /// Optional add-ons this build carries (SqueakMacAddons; none in the release). Registered in `init`.
    @ObservationIgnored let addons = AddonRegistry.shared
    /// The first-run checklist's facts (AppModel+Setup.swift).
    @ObservationIgnored lazy var setup = SetupModel(client: client, demo: demoMode || captureMode)
    /// The background service Squeak installs and updates for installs without a checkout (DaemonManager.swift).
    @ObservationIgnored lazy var daemon = DaemonManager(enabled: !(demoMode || captureMode))
    @ObservationIgnored var openConversationWindow: (() -> Void)?
    /// Closes the menu-bar panel; installed by its controller. Called before focus moves to a window.
    @ObservationIgnored var dismissMenuBar: (() -> Void)?
    /// The window that hosts `ConversationView`, registered by the view itself.
    @ObservationIgnored weak var conversationWindow: NSWindow?
    /// The conversation window is in macOS full screen: the traffic lights are hidden, so nothing reserves room for them.
    var conversationFullScreen = false
    /// Full screen: the pointer is at the top, so the window controls are slid into the sidebar's top row (FullScreenLights).
    var fullScreenLightsRevealed = false
    @ObservationIgnored private var started = false
    /// What every poll loop reads: paused while no window shows, slower while another app is in front (PollLoop).
    @ObservationIgnored let pollGate = PollPresenceGate()
    @ObservationIgnored var extrasThrottle = PollThrottle()
    @ObservationIgnored var extrasKey: SessionKey?
    /// Inline thread rename (who is editing, the last refusal) and the new name shown until the host's list catches up.
    var inlineRename = InlineRename<SessionKey>()
    var renameOverride: [SessionKey: String] = [:]
    @ObservationIgnored private var visibilityTokens: [NSObjectProtocol] = []

    // MARK: Catalog and connection
    /// What the host's catalog last said, untouched: the optimistic overlay and the status observers read this.
    private(set) var hostSessions: [HostSession] = [] { didSet { overlayCache.invalidate(); inputsChanged() } }
    @ObservationIgnored private var overlayCache = OverlayCache()
    /// Every surface (sidebar rows and groups, tabs, pond counts, menu-bar mark, Dock badge) reads this: the host's
    /// sessions with a chat read as working from the moment Send was pressed (`OptimisticWork.overlay`).
    /// Cached: recomputed only when `hostSessions` or `optimistic` changes (the reads below register both for observation).
    var sessions: [HostSession] {
        let all = allSessions
        if let c = listedCache, c.source == all { return c.listed }
        let listed = ThreadArchive.listed(all)
        listedCache = (all, listed)
        return listed
    }
    /// Every chat the host knows, archived ones included: only the archived views and `session(_:)` read this.
    var allSessions: [HostSession] { overlayCache.value(hostSessions, work: optimistic, now: Date()) }
    /// Archived Squeak chats, newest archived first (the sidebar's Archived entry and the pond's archived section).
    var archivedSessions: [HostSession] { ThreadArchive.archived(allSessions) }
    @ObservationIgnored private var listedCache: (source: [HostSession], listed: [HostSession])?
    private(set) var health: AdapterHealth?
    private(set) var hasLoaded = false
    private(set) var tokenPresent = true
    private(set) var firstConnectionSeen = false
    private(set) var adapterHealths: [String: AdapterHealth] = [:]
    /// What the daemon carries as add-ons, and which are on (Settings › Extensions; AppModel+Addons.swift).
    var addonCatalogue: [AddonInfo] = []
    var enabledAddons: Set<String> = []
    /// The daemon predates add-ons.
    var addonsOldDaemon = false
    var extensionState = ExtensionActionState()
    @ObservationIgnored var addonsLoaded = false
    @ObservationIgnored var addonsApplied = false

    // MARK: Updates (Sparkle installs them; see Updater.swift)
    let updater = AppUpdater()

    // MARK: Selection and conversation
    private(set) var selected: SessionKey? { didSet { if selected != oldValue { openDuckling = DucklingRef.open(openDuckling, whenSelected: selected); inputsChanged() } } }
    /// Bumped whenever an input of the derived values below changes (sessions, optimistic work, selection, read log,
    /// pins, filters, started chats). Reads of those values register it, so a view re-runs on a real change only;
    /// each value is computed once per bump (`DerivedSessions`), not once per read.
    private(set) var derivedRevision = 0
    @ObservationIgnored let derived = DerivedSessions()
    func inputsChanged() {
        derived.invalidateAll()
        derivedRevision &+= 1
    }
    /// Retained when Dashboard clears the selection, so its Continue action returns to the same work.
    private(set) var lastWorkspaceSession: SessionKey?

    var dashboardResumeSession: HostSession? {
        session(lastWorkspaceSession) ?? visibleSessions.min(by: HomeProjects.before)
    }
    /// The dashboard's project or workspace filter (the chat header's breadcrumb sets it); nil shows everything.
    var dashboardFilter: DashboardFilter?
    /// The duckling open in the thread's side panel (`DucklingPanel`); nil when none.
    var openDuckling: DucklingRef?
    private(set) var messages: [ChatMessage] {
        get { chatStore.messages }
        set { publishIfChanged(chatStore, \.messages, newValue) }
    }
    /// Chats read as working from the moment Send was pressed, until the host's own word about our turn (OptimisticWork.swift).
    private(set) var optimistic: [SessionKey: OptimisticWork] = [:] { didSet { overlayCache.invalidate(); inputsChanged() } }
    /// The open chat's transcript without the steers still waiting to be taken in: those are cards in the queue stack.
    var displayMessages: [ChatMessage] { native.key == selected ? native.pending.visible(messages) : messages }
    /// How far back the open chat has been read, for the row at the top of the conversation.
    private(set) var paging: EarlierPaging {
        get { chatStore.paging }
        set { publishIfChanged(chatStore, \.paging, newValue) }
    }
    private(set) var turnWork: [String: [ActivityStep]] {
        get { chatStore.turnWork }
        set { publishIfChanged(chatStore, \.turnWork, newValue) }
    }
    private(set) var activity: [ActivityStep] {
        get { chatStore.activity }
        set { publishIfChanged(chatStore, \.activity, newValue) }
    }
    /// The open Conductor chat's model, stuck state, workspace and background work, from the daemon (ChatActions.swift).
    var chatExtras: ChatExtras? {
        get { chatStore.chatExtras }
        set { publishIfChanged(chatStore, \.chatExtras, newValue) }
    }
    /// The models a chat can switch to, read once a chat with a model is open.
    var chatModels: [DaemonChatModel] = []
    /// Repositories a new workspace can be made in; nil from a daemon that cannot make one.
    var workspaceRepos: [DaemonRepo]?
    /// Why the last chat action (model, Stop, PR, archive) did not happen; shown above the composer.
    var chatNote: String?
    /// A chat action is on its way.
    var chatBusy = false
    private(set) var openURL: URL?
    private(set) var draft = ""
    /// The agent's last message for sessions that need you, so cards can show the question and options.
    private(set) var needsYouText: [SessionKey: String] = [:]
    /// The structured question or plan each blocked Conductor chat waits on (the question card).
    private(set) var asks: [SessionKey: PendingAsk] = [:]
    private(set) var answeredAsks: [SessionKey: (ask: PendingAsk, outcome: AnswerOutcome, at: Date)] = [:]
    /// A card whose question stopped being pending without this Mac answering it: kept, disabled, "Answered elsewhere".
    private(set) var staleAsks: [SessionKey: (ask: PendingAsk, at: Date)] = [:]
    @ObservationIgnored private var askFetchedAt: [SessionKey: Date?] = [:]
    @ObservationIgnored private var needsYouFetchedAt: [SessionKey: Date?] = [:]
    @ObservationIgnored private var knownMessages: [SessionKey: [ChatMessage]] = [:]
    @ObservationIgnored private var draftTask: Task<Void, Never>?
    /// Pictures waiting in each chat's composer, kept per chat so a state change or a chat switch never drops them.
    @ObservationIgnored private var imageTrays: [SessionKey: ImageTray] = [:]
    func imageTray(for key: SessionKey) -> ImageTray {
        if let t = imageTrays[key] { return t }
        let t = ImageTray(); imageTrays[key] = t; return t
    }
    @ObservationIgnored var queueStores: [String: QueueStore] = [:]
    @ObservationIgnored var changesStores: [String: ChangesStore] = [:]
    /// One file browser and its open files per workspace folder (`FilesModel.swift`).
    @ObservationIgnored var filesModels: [String: FilesModel] = [:]
    /// Git, pull request, workspace lifecycle and project settings of the Squeak-run chats (`AppModel+Git.swift`).
    let git = GitModel()
    /// What a send to a working chat does by default (the daemon's `/control/send-default`); nil until read.
    var sendDefault = SendDefault(.queue)
    enum SendDefaultLoad: Equatable { case loading, ready, unavailable(String) }
    var sendDefaultLoad: SendDefaultLoad = .loading
    /// When the open conversation's transcript was last read; what it shows is no newer than this.
    @ObservationIgnored private var selectedLoadedAt: Date?
    /// The chat whose first transcript / activity read has answered, so a screen says "loading" and never "nothing yet" before.
    private var transcriptReadKey: SessionKey?
    private var activityReadKey: SessionKey?
    var transcriptPhase: ScreenLoad { ScreenLoad.phase(hasContent: !messages.isEmpty, firstReadDone: selected == nil || transcriptReadKey == selected) }
    var activityPhase: ScreenLoad { ScreenLoad.phase(hasContent: !activity.isEmpty, firstReadDone: selected == nil || activityReadKey == selected) }

    // MARK: Updates the user has not seen, and the menu's reply excerpts
    /// Event ids and times per chat (no text), kept until content that includes the event is displayed.
    private(set) var unread: UnreadTracker
    /// Which finished chats this Mac has opened (DESIGN.md §3.3: a chat is unread from a finished turn until opened).
    /// Local only; demo and capture runs neither read nor write the real record.
    private(set) var seenLog: ChatSeenLog { didSet { if seenLog != oldValue { inputsChanged() } } }
    /// A short excerpt of the newest reply for recent finished and errored sessions, for the menu.
    private(set) var menuReplyPreviews: [SessionKey: String] = [:]
    @ObservationIgnored private var nativeNotifyGate = NativeNotifyGate()
    @ObservationIgnored private var anchorLog: NotificationAnchorLog
    @ObservationIgnored private var previewFetches: [SessionKey: (activity: Date?, tried: Date, ok: Bool)] = [:]
    @ObservationIgnored private var previewsRefreshing = false
    /// Replies that notifications were about, kept apart from the conversation cache so a click
    /// after a relaunch still opens on its own reply. Encrypted like the cache; nil in demo and capture runs.
    @ObservationIgnored let contextCache: EncryptedCache?

    // MARK: Browsing
    var query = ""
    var filter: SessionFilter = .all { didSet { inputsChanged() } }
    var navFilter: NavFilter? = .home {
        // Usage is a screen of its own, so no chat stays open behind it; picking a chat leaves it.
        didSet {
            if navFilter == .usage, selected != nil { select(nil) }
            if navFilter != oldValue { projectFilter = nil; inputsChanged() }
        }
    }
    /// The project Home is drilled into (`HomeProject.name`); nil shows every project. See AppModel+Projects.swift.
    var projectFilter: String?
    /// A short live phrase per working session ("Running tests"), for the list rows.
    private(set) var liveSteps: [SessionKey: String] {
        get { chatStore.liveSteps }
        set { publishIfChanged(chatStore, \.liveSteps, newValue) }
    }
    private(set) var pinned: Set<SessionKey> { didSet { if pinned != oldValue { inputsChanged() } } }
    private(set) var workspaceTabOrder = WorkspaceTabOrder()

    func synchronizeChatTabs(_ workspace: SidebarWorkspace) {
        guard let next = workspaceTabOrder.synchronized(workspace: workspace.id, available: workspace.chats.map { $0.key.stringValue }) else { return }
        workspaceTabOrder = next
        saveChatTabOrder()
    }

    func moveChatTab(_ source: String, before target: SessionKey, workspace: SidebarWorkspace) -> Bool {
        let moved = workspaceTabOrder.move(workspace: workspace.id, source: source, before: target.stringValue,
                                          available: workspace.chats.map { $0.key.stringValue })
        if moved { saveChatTabOrder() }
        return moved
    }

    private func saveChatTabOrder() {
        guard !demoMode, !captureMode, let data = try? JSONEncoder().encode(workspaceTabOrder) else { return }
        defaults.set(data, forKey: "workspaceChatTabOrder")
    }

    // MARK: Settings (persisted in UserDefaults; nothing sensitive)
    var hotKeyID: String? { didSet { defaults.set(HotKeyPreference.storedValue(for: hotKeyID), forKey: "hotKey"); HotKeyCenter.shared.register(HotKeyPreset.preset(id: hotKeyID)) } }
    var notificationsEnabled: Bool { didSet { defaults.set(notificationsEnabled, forKey: "notifications") } }
    var notificationsShowNames: Bool { didSet { defaults.set(notificationsShowNames, forKey: "notificationNames") } }
    /// "Tell me when an update is available": the dot on the menu-bar mark and the one notification per version.
    var updateAlertsEnabled: Bool { didSet { defaults.set(updateAlertsEnabled, forKey: "updateAlerts"); updateStateChanged() } }
    var updateBadgeShown: Bool {
        UpdateAlert.badgeShown(available: updater.availableVersion, ready: updater.readyVersion, switchOn: updateAlertsEnabled)
    }
    var launchOfferPending = false
    var windowVisible = false
    var onboardingDone: Bool { didSet { defaults.set(onboardingDone, forKey: "onboardingDone") } }
    private(set) var lastUsed: SessionKey?
    var cacheNotice: String?

    @ObservationIgnored private let defaults = UserDefaults.standard
    /// Wakes the broker the moment an enabled add-on's files change (Conductor's database), in either poll mode.
    @ObservationIgnored var addonWatcher: FileChangeWatcher?

    init() {
        let env = ProcessInfo.processInfo.environment
        captureMode = env["SQUEAK_MAC_CAPTURE"] != nil
        demoMode = env["SQUEAK_MAC_DEMO"] == "1"
        let tips = TipsModel(demo: demoMode || captureMode)
        self.tips = tips
        var live = DaemonClient.live()
        live.onReplySignal = { signal in Task { @MainActor in tips.note(signal) } }
        client = live
        InstalledAddons.register(client: live, demo: demoMode || captureMode, into: AddonRegistry.shared)
        // The capture run never touches the real cache file or its key.
        if captureMode || demoMode {
            cache = nil
        } else {
            cache = EncryptedCache(keyStore: FileKeyStore(directory: EncryptedCache.defaultDirectory))
        }
        let draftStore = cache.map { DraftStore(cache: $0) }
        if cache == nil {
            contextCache = nil
        } else {
            let dir = EncryptedCache.defaultDirectory.appending(path: "Notification Context")
            contextCache = EncryptedCache(
                configuration: .init(directory: dir, keyAccount: "context-cache-key", sizeCap: 8 * 1024 * 1024),
                keyStore: FileKeyStore(directory: dir))
        }
        let d = UserDefaults.standard
        // Add-ons are on only as the daemon last said (kept for when it is down); a demo or capture run has its own.
        let saved: Set<String> = demoMode || captureMode ? [] : Set(d.stringArray(forKey: "enabledAddons") ?? [])
        enabledAddons = saved
        let on = AddonRegistry.shared.apps.filter { saved.contains($0.id) }
        broker = Broker(adapters: SessionSources.adapters(client: client, native: NativeHostClient.beside(client), addons: on), cache: cache, draftStore: draftStore)
        if !demoMode, !captureMode, let data = d.data(forKey: "workspaceChatTabOrder"),
           let saved = try? JSONDecoder().decode(WorkspaceTabOrder.self, from: data) { workspaceTabOrder = saved }
        pinned = Set((d.stringArray(forKey: "pinned") ?? []).compactMap(SessionKey.init(stringValue:)))
        hotKeyID = HotKeyPreference.resolve(stored: d.string(forKey: "hotKey"), alreadyMigrated: d.bool(forKey: HotKeyPreference.migrationKey))
        notificationsEnabled = d.object(forKey: "notifications") as? Bool ?? true
        notificationsShowNames = d.bool(forKey: "notificationNames")
        updateAlertsEnabled = d.object(forKey: "updateAlerts") as? Bool ?? true
        onboardingDone = d.bool(forKey: "onboardingDone")
        lastUsed = d.string(forKey: "lastUsed").flatMap(SessionKey.init(stringValue:))
        // Demo and capture runs neither read nor write the real unread and anchor state.
        let real = !(captureMode || demoMode)
        unread = real ? d.data(forKey: "unreadUpdates").flatMap { try? JSONDecoder().decode(UnreadTracker.self, from: $0) } ?? UnreadTracker() : UnreadTracker()
        if real, let data = d.data(forKey: "chatSeenLog"), let log = try? JSONDecoder().decode(ChatSeenLog.self, from: data) {
            seenLog = log
        } else if real {
            // First run: whatever finished before now counts as read, so an update does not light every recent chat.
            let fresh = ChatSeenLog(baseline: Date())
            d.set(try? JSONEncoder().encode(fresh), forKey: "chatSeenLog")
            seenLog = fresh
        } else {
            seenLog = ChatSeenLog()
        }
        anchorLog = real ? d.data(forKey: "notificationAnchors").flatMap { try? JSONDecoder().decode(NotificationAnchorLog.self, from: $0) } ?? NotificationAnchorLog() : NotificationAnchorLog()
        HotKeyCenter.shared.isDisabled = captureMode || demoMode
        HotKeyCenter.shared.previewNotGranted = demoMode
        if !(captureMode || demoMode) {
            d.set(true, forKey: HotKeyPreference.migrationKey)
            d.set(HotKeyPreference.storedValue(for: hotKeyID), forKey: "hotKey")
        }
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
        HotKeyCenter.shared.onFire = { QuickComposerController.shared.toggle() }
        HotKeyCenter.shared.register(HotKeyPreset.preset(id: hotKeyID))  // a no-op in capture and demo runs
        // Input Monitoring is granted in System Settings: pick it up the moment the app comes back.
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { HotKeyCenter.shared.recheck(); AppModel.shared.daemon.recheckPermission() }
        }
        Notifier.shared.onOpen = { open in QuickComposerController.shared.show(notification: open) }
        // An update notification opens Settings > About: it names no chat, so the composer never hears of it.
        Notifier.shared.onOpenUpdate = { [weak self] in self?.openSettings(.about) }
        Notifier.shared.onRevokeDevice = { [weak self] id in Task { await self?.channels.revoke(id) } }
        Notifier.shared.onOpenDevices = { [weak self] in self?.openSettings(.iphone) }
        Notifier.shared.onOpenPond = { [weak self] id in
            guard let self, let pond = PondsModel.shared.ponds.first(where: { $0.id == id }) else { return }
            self.showConversationWindow()
            PondsModel.shared.route = .home(project: PondsModel.shared.key(forPond: pond))
        }
        channels.onDeviceAutoAdded = { d, email in Notifier.shared.postDeviceAdded(id: d.id, name: d.name, email: email) }
        Notifier.shared.onApproveDevice = { [weak self] id in Task { await self?.channels.approve(id) } }
        channels.onDeviceWaiting = { [weak self] p in Notifier.shared.postDeviceRequest(id: p.id, name: p.name, email: p.email ?? self?.channels.remote?.account?.email) }
        if !demoMode, !captureMode, Bundled.isApp { Task { [weak self] in await self?.channels.watchDevices() } }
        updater.onChange = { [weak self] in self?.updateStateChanged() }
        // The sidebar card is the update UI: make sure the conversation window (which holds it) is on screen.
        updater.onNeedsAttention = { [weak self] in self?.showUpdateWhereThePersonIs() }
        if demoMode, let v = ProcessInfo.processInfo.environment["SQUEAK_MAC_DEMO_UPDATE"], !v.isEmpty {
            updater.demoFound(v, notes: ["The menu-bar mark shows a dot when an update is waiting."])
        }
        observeWindowVisibility()
        AppLog.info("started version \(Self.appVersion), add-ons on: \(enabledAddons.sorted().joined(separator: ", "))")
        if demoMode { installDemo(); return }
        updater.start(enabled: !captureMode)
        QuickComposerController.shared.state.restoreDrafts()
        UpdateInstallController.shared.resume(
            offeredVersion: { [weak self] in self?.updater.availableVersion ?? self?.updater.readyVersion },
            perform: { [weak self] in self?.updater.installWhenReady() })
        daemon.reconcileAtLaunch()
        if !captureMode {
            let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/squeak")
            let outcome = HandsInstaller.reconcile(
                bundled: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Squeak Hands.app"),
                installed: support.appendingPathComponent("Squeak Hands.app"))
            if case .installed(let v) = outcome { AppLog.info("Squeak Hands \(v) installed") }
            if case .failed(let why) = outcome { AppLog.error("Squeak Hands install: \(why)") }
        }
        Task { [weak self] in await self?.watchAddons() }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self else { return }
            await setup.refresh(self)
        }
        Task { [weak self] in
            guard let self else { return }
            await broker.restoreFromCache()
            if let cache { knownMessages = (try? await cache.allMessages()) ?? [:] }
            await broker.setMode(.background)
            await broker.start()
            startAddonWatcher()
            await restoreAfterUpdate()
        }
        Task { [weak self] in
            guard let self else { return }
            for await event in broker.events { await handle(event) }
        }
        Task { [weak self] in
            while !Task.isCancelled {
                self?.tokenPresent = self?.client.hasToken ?? true
                if let self { await tips.refresh(self) }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func handle(_ event: BrokerEvent) async {
        switch event {
        case .catalogChanged:
            _ = publishIfChanged(self, \.hostSessions, await broker.sessions())
            // Chats with no seq to compare (Conductor, terminal): the host's word about a turn we started.
            for s in hostSessions where s.source != .squeak && optimistic[s.key] != nil {
                noteOptimistic(s.key) { $0.observe(status: s.state) }
            }
            startedChats.prune(listed: sessions, now: Date())
            markOpenChatSeen()
            hasLoaded = true
            if let selected, openURL == nil { openURL = await broker.openInHostURL(for: selected) }
            await refreshNeedsYouText()
            await refreshAsks()
        case .messagesChanged(let key):
            let all = await broker.messages(for: key)
            knownMessages[key] = all
            derived.messagesChanged(key)
            if let s = hostSessions.first(where: { $0.key == key }), s.source != .squeak, let sent = optimistic[key]?.sentAt,
               let last = all.last, last.role == .assistant, (last.at ?? .distantPast) > sent {
                noteOptimistic(key) { $0.observeReply(host: s.state) }
            }
            if key == selected {
                transcriptReadKey = key
                _ = publishIfChanged(self, \.messages, all)
                _ = publishIfChanged(self, \.turnWork, await broker.turns(for: key))
                let state = await broker.paging(for: key)
                if state != paging { paging = state }
                selectedLoadedAt = Date()
                markSelectedDisplayed()
            }
        case .connection(let h):
            let summary = await broker.connectionSummary() ?? h
            if health?.status != summary.status {
                AppLog.info("connection \(DiagnosticsInput.describe(summary.status)) (\(h.adapterId))")
            }
            health = summary
            adapterHealths = Dictionary(uniqueKeysWithValues: await broker.healths().map { ($0.adapterId, $0) })
            if adapterHealths.values.contains(where: { $0.status == .connected }) {
                hasLoaded = true
                _ = publishIfChanged(self, \.hostSessions, await broker.sessions())
                if !firstConnectionSeen {
                    firstConnectionSeen = true
                    if !captureMode, Bundled.isApp, notificationsEnabled { Notifier.shared.requestAuthorization() }
                    if !defaults.bool(forKey: "launchOffered"), !LoginItem.isEnabled, Bundled.isApp { launchOfferPending = true }
                }
            }
        case .notify(let n):
            guard !captureMode else { return }
            let displayed = n.key == selected && conversationOnScreen
            // Unread whether or not a banner is shown: the menu's dot is about the update, not the banner.
            if !displayed, let id = n.id { noteUnread(n.key, id: id, at: n.at ?? Date()) }
            guard notificationsEnabled else { return }
            // A Squeak-run chat's needs-you notification: never for the chat in the front window, once per request.
            if session(n.key)?.source == .squeak, n.kind == .blocked || n.kind == .question || n.kind == .plan {
                let request = (n.key == native.key ? native.card?.id : nil) ?? n.id
                guard nativeNotifyGate.admit(requestId: request, frontmost: displayed) else { return }
            } else if displayed { return }
            // Off the event loop: a slow transcript read must not hold up the next event.
            Task { [weak self] in await self?.deliver(n) }
        }
    }

    // MARK: Update alert

    /// One notification per new version, remembered across launches. Never in capture or demo runs.
    private func updateStateChanged() {
        guard !captureMode, !demoMode, Bundled.isApp else { return }
        let downloaded = updater.readyVersion != nil
        let version = UpdateAlert.pendingVersion(available: updater.availableVersion, ready: updater.readyVersion)
        guard UpdateAlert.shouldNotify(
            version: version, lastNotified: defaults.string(forKey: "updateNotifiedVersion"),
            skipped: updater.skippedVersion, switchOn: updateAlertsEnabled, notificationsOn: notificationsEnabled),
            let version else { return }
        defaults.set(version, forKey: "updateNotifiedVersion")
        Notifier.shared.postUpdate(UpdateAlert.payload(
            version: version, downloaded: downloaded, notes: downloaded ? updater.readyNotes : updater.availableNotes))
    }

    // MARK: Notification delivery and unread

    /// Posts at once if the reply is not pinned within a second; the capture goes on and is kept,
    /// so a click on a notification that left without ids still finds its message.
    private func deliver(_ n: NotificationEvent) async {
        let broker = broker
        let capture = Task { [weak self] in
            let c = await broker.capture(n)
            await self?.record(c, for: n.key)
            return c.anchor
        }
        let anchor = await Self.race(within: .seconds(1)) { await capture.value }
        Notifier.shared.post(n, showName: notificationsShowNames, anchor: anchor ?? NotificationAnchor(event: n))
    }

    private func record(_ capture: NotificationCapture, for key: SessionKey) async {
        guard let anchor = capture.anchor else { return }
        anchorLog.record(anchor)
        if !(captureMode || demoMode), let data = try? JSONEncoder().encode(anchorLog) { defaults.set(data, forKey: "notificationAnchors") }
        if !capture.messages.isEmpty { try? await contextCache?.putMessages(capture.messages, for: key) }
    }

    /// The first of `work` and a timeout; `work` itself is never cancelled by losing.
    private static func race<T: Sendable>(within limit: Duration, _ work: @escaping @Sendable () async -> T?) async -> T? {
        await withCheckedContinuation { (c: CheckedContinuation<T?, Never>) in
            let once = Once(c)
            Task { once.fire(await work()) }
            Task { try? await Task.sleep(for: limit); once.fire(nil) }
        }
    }

    private func noteUnread(_ key: SessionKey, id: String, at: Date) {
        if unread.note(key, id: id, at: at) { saveUnread() }
    }

    private func saveUnread() {
        if !(captureMode || demoMode), let data = try? JSONEncoder().encode(unread) { defaults.set(data, forKey: "unreadUpdates") }
    }

    /// True while the conversation window itself is showing: not Settings, the quick composer or the menu.
    private var conversationOnScreen: Bool {
        if captureMode { return true }
        guard let w = conversationWindow else { return false }
        return w.isVisible && !w.isMiniaturized && w.occlusionState.contains(.visible)
    }

    func hasUnreadUpdate(for key: SessionKey) -> Bool { unread.hasUnread(key) }

    /// Reads everything pending for a chat. For an explicit "mark as read"; opening the menu is not one.
    func markUpdateRead(for key: SessionKey) {
        guard unread.hasUnread(key) else { return }
        unread.markRead(key)
        saveUnread()
    }

    /// The composer showed a chat's reply: reads its events up to `through` (the event's own time,
    /// or when the transcript was fetched), never a later one.
    func markContextDisplayed(_ key: SessionKey, eventId: String?, through: Date) {
        if let eventId { unread.markRead(eventId: eventId) }
        unread.markRead(key, through: through)
        saveUnread()
    }

    /// The conversation window shows `selected` and its transcript has loaded: what it shows is read.
    /// The mark a chat shows in a list, or nil (the age shows). The open chat is never unread: it is on screen.
    /// The session with the host's record of its background work folded in while it is the open Squeak chat: the same
    /// source the composer bar reads, so the sidebar and tabs agree with it.
    func withHostBackground(_ s: HostSession) -> HostSession {
        guard s.source == .squeak, native.key == s.key, let info = native.info else { return s }
        var s = s
        if s.ducklings == nil { s.ducklings = info.ducklings }
        if s.backgroundCount == nil { s.backgroundCount = info.backgroundCount }
        return s
    }

    func mark(for session: HostSession) -> ChatMark? {
        let s = withHostBackground(session)
        _ = derivedRevision
        let now = Date()
        return derived.marks.value(s.key, bucket: TimeBucket.of(now), fresh: { $0.session == s }) { .init(session: s, value: ChatMark.of(s, unread: isUnread(s), now: now)) }.value
    }

    /// A sidebar row's VoiceOver label, built once per change (the date formatter is shared, not made per row).
    func rowAccessibility(_ s: HostSession) -> String {
        _ = derivedRevision
        let now = Date()
        return derived.labels.value(s.key, bucket: TimeBucket.of(now), fresh: { $0.session == s }) {
            .init(session: s, value: SessionText.accessibility(title: workbenchTitle(s), mark: mark(for: s), last: s.lastActivityAt, now: now))
        }.value
    }

    func isUnread(_ s: HostSession) -> Bool {
        if s.key == selected, conversationOnScreen { return false }
        return seenLog.isUnread(s)
    }

    /// The person's "mark as read / unread" (R on a sidebar row): the chat's finished turn counts as opened, or not yet.
    func setSeen(_ s: HostSession, seen: Bool) {
        let before = seenLog
        if seen { seenLog.markOpened(s) } else { seenLog.markUnread(s) }
        if seenLog != before { defaults.set(try? JSONEncoder().encode(seenLog), forKey: "chatSeenLog") }
    }

    /// The open chat's finished turn is read the moment it is on screen (and whenever a newer one ends under it).
    private func markOpenChatSeen() {
        guard !captureMode, !demoMode, let key = selected, conversationOnScreen, let s = session(key) else { return }
        let before = seenLog
        seenLog.markOpened(s)
        if seenLog != before { defaults.set(try? JSONEncoder().encode(seenLog), forKey: "chatSeenLog") }
    }

    private func markSelectedDisplayed() {
        markOpenChatSeen()
        guard let key = selected, let loaded = selectedLoadedAt, unread.hasUnread(key), conversationOnScreen else { return }
        unread.markRead(key, through: loaded)
        saveUnread()
    }

    /// Fills the model from DemoData and stops there: no broker, no polling, no network.
    func installDemo() {
        let d = DemoData.make()
        hostSessions = d.sessions
        for s in d.sessions where d.read.contains(s.key) { seenLog.markOpened(s) }
        needsYouText = d.needsYouText
        asks = d.asks
        health = AdapterHealth(adapterId: "demo", status: .connected, lastSyncedAt: Date())
        enabledAddons = Set(AddonRegistry.shared.apps.map(\.id))
        addonCatalogue = AddonRegistry.shared.apps.map { AddonInfo(id: $0.id, name: $0.hostName, blurb: $0.summary, available: true, enabled: true) }
        adapterHealths = ["daemon": AdapterHealth(adapterId: "daemon", status: .connected, lastSyncedAt: Date())]
        for app in AddonRegistry.shared.apps {
            for id in app.adapterNames.keys { adapterHealths[id] = AdapterHealth(adapterId: id, status: .connected, lastSyncedAt: Date()) }
        }
        tokenPresent = true
        hasLoaded = true
        firstConnectionSeen = true
        usage = DemoData.usage()
        Task { await refreshLiveSteps() }
    }

    /// Capture only: the Needs you page shown as the lettered-option buttons (no live question card).
    func demoSetAsks(_ new: [SessionKey: PendingAsk]) {
        guard demoMode else { return }
        asks = new
    }

    // MARK: Window visibility drives the poll mode

    private func observeWindowVisibility() {
        let nc = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.willCloseNotification,
            NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
            NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
        ]
        for name in names {
            visibilityTokens.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.recomputeVisibility() }
            })
        }
    }

    func recomputeVisibility() {
        inputsChanged()  // what counts as "on screen" moves with the windows (marks read it)
        let visible = captureMode || NSApp.windows.contains { w in
            w.isVisible && w.canBecomeKey && !w.isMiniaturized && w.occlusionState.contains(.visible)
        }
        pollGate.set(!visible ? .hidden : (NSApp.isActive || captureMode ? .active : .inactive))
        if visible && !windowVisible { extrasThrottle.reset() }
        guard visible != windowVisible else { return }
        windowVisible = visible
        Task { await broker.setMode(visible ? .foreground : .background) }
        if visible { markSelectedDisplayed() }
    }

    /// The source answered on the last poll, so a transcript read just now is current.
    private var transcriptIsLive: Bool {
        isConnected || ownSourcesConnected
    }

    // MARK: Derived

    var effectiveStatus: ConnectionStatus {
        guard let h = health else { return .degraded("Connecting") }
        if h.status == .connected, !tokenPresent { return .tokenMissing }
        return h.status
    }

    var isConnected: Bool { effectiveStatus == .connected }

    /// Squeak's own chats live in the session host (a deploy never restarts it), so they depend only
    /// on that adapter; every other chat depends on the daemon.
    func isOffline(for session: HostSession) -> Bool {
        guard session.source == .squeak else { return !isConnected }
        guard let h = adapterHealths["squeak-native"] else { return !isConnected }
        return h.status != .connected
    }

    /// The service this chat needs is answering, so a reply can be sent now.
    func isReachable(_ session: HostSession) -> Bool { !isOffline(for: session) }

    var visibleSessions: [HostSession] {
        _ = derivedRevision
        let now = Date()
        return derived.visible.value(bucket: TimeBucket.of(now)) {
            sessions.filter { s in
                switch filter {
                case .all: break
                case .provider(let p): if s.key.provider != p { return false }
                case .repo(let r): if s.repoName != r { return false }
                }
                switch navFilter ?? .all {
                case .all, .home: return true
                case .needsYou: return SessionGrouping.kind(of: s, now: now) == .needsYou
                case .working: return SessionGrouping.kind(of: s, now: now) == .working
                case .done: return SessionGrouping.kind(of: s, now: now) == .done
                case .source(let src): return s.source == src
                case .usage: return true
                }
            }
        }
    }

    /// Sessions in a sidebar filter, whatever filter is selected now (for the counts). Cached per filter.
    func count(_ f: NavFilter) -> Int {
        _ = derivedRevision
        let now = Date()
        return derived.counts.value(f, bucket: TimeBucket.of(now)) {
            switch f {
            case .all: sessions.filter { !SessionGrouping.isEarlier($0, now: now) }.count
            case .needsYou: sessions.filter { SessionGrouping.kind(of: $0, now: now) == .needsYou }.count
            case .working: sessions.filter { SessionGrouping.kind(of: $0, now: now) == .working }.count
            case .done: sessions.filter { SessionGrouping.kind(of: $0, now: now) == .done }.count
            case .source(let src): sessions.filter { $0.source == src }.count
            case .usage, .home: 0
            }
        }
    }

    var hasCodexApp: Bool { _ = derivedRevision; return derived.hasCodex.value { sessions.contains { $0.source == .codexApp } } }

    func liveStep(_ key: SessionKey) -> String? { liveSteps[key] }

    @ObservationIgnored private var activityFeed = ActivityFeedMerge()
    @ObservationIgnored private var liveStepsAt = Date.distantPast
    @ObservationIgnored private var liveStepsRefreshing = false

    /// The newest step of each working session in the list (at most 8) as one short phrase each, read
    /// from the same activity feed as the detail. Cheap by construction: only working sessions that
    /// are listed, at most one pass every 4s however many views ask, and a failed read keeps the last
    /// phrase. A session with no steps yet gets no phrase, so its row says "working", never a guess.
    @discardableResult
    func refreshLiveSteps(force: Bool = false) async -> Bool {
        guard force || Date().timeIntervalSince(liveStepsAt) >= 4, !liveStepsRefreshing else { return false }
        liveStepsRefreshing = true
        defer { liveStepsRefreshing = false }
        liveStepsAt = Date()
        let now = Date()
        let working = visibleSessions.filter { SessionGrouping.kind(of: $0, now: now) == .working }.prefix(8)
        var out: [SessionKey: String] = [:]
        for s in working {
            let steps: [ActivityStep]
            if demoMode { steps = DemoData.activity(for: s.key) } else if let read = try? await broker.activity(for: s.key) {
                steps = read
            } else {
                if let old = liveSteps[s.key] { out[s.key] = old }
                continue
            }
            if let line = ActivityPhrase.rowLine(steps) { out[s.key] = line }
        }
        return publishIfChanged(self, \.liveSteps, out)
    }

    /// Every 5 s while phrases change, backing off to 15 s while they do not; nothing while no window shows.
    func pollLiveSteps() async {
        await PollLoop.run(gate: pollGate, base: { 5 }, max: 15) { await self.refreshLiveSteps() }
    }

    /// Real data only. Squeak's adapters expose no diff or test results, so live sessions have none.
    func summaryLine(for s: HostSession) -> String? { demoMode ? DemoData.summary(for: s.key) : nil }

    /// Chats waiting on the person (blocked and alive), newest first.
    var waitingKeys: [SessionKey] {
        let now = Date()
        return visibleSessions.filter { SessionGrouping.kind(of: $0, now: now) == .needsYou }.sorted(by: HomeProjects.before).map(\.key)
    }

    /// The agent's latest message for a session: the open transcript, else the cached card text.
    func lastAgentText(_ key: SessionKey) -> String? {
        knownMessages[key]?.last(where: { $0.role == .assistant })?.text ?? needsYouText[key]
    }

    /// The title the workbench shows: the chat's own, or for the "<repo> · <workspace>" fallback its first message.
    func workbenchTitle(_ s: HostSession) -> String {
        if let shown = renameOverride[s.key] { return shown }
        _ = derivedRevision
        return derived.titles.value(s.key, fresh: { $0.session == s }) {
            .init(session: s, value: ChatTitle.resolve(
                s, headline: SessionText.headline(s),
                firstMessage: ChatTitle.isFallback(s) ? knownMessages[s.key]?.first(where: { $0.role == .user })?.text : nil))
        }.value
    }

    func choices(for key: SessionKey) -> [Choice] { lastAgentText(key).map(Choices.parse) ?? [] }

    /// The question line for a card: the parsed question when options exist, else the text's tail.
    func question(for key: SessionKey) -> String? {
        guard let t = lastAgentText(key), !t.isEmpty else { return nil }
        if let q = Choices.parseFull(t)?.question { return q }
        return Choices.stripMarkdown(t)
    }

    func ask(for key: SessionKey) -> PendingAsk? { asks[key] }

    /// The card to show: the live question, or for 90 seconds the one just answered, so its result line stays.
    func askDisplay(for key: SessionKey) -> (ask: PendingAsk, outcome: AnswerOutcome?)? {
        if let a = asks[key] { return (a, nil) }
        if let d = answeredAsks[key], Date().timeIntervalSince(d.at) < 90 { return (d.ask, d.outcome) }
        return nil
    }

    /// The conversation's card, with what it may do (`DecisionPhase`): live while its question is the pending one,
    /// the result line after this Mac answered, disabled "Answered elsewhere" when someone else did.
    func askCardDisplay(for key: SessionKey) -> (ask: PendingAsk, outcome: AnswerOutcome?, phase: DecisionPhase)? {
        let answeredHere = answeredAsks[key].flatMap { Date().timeIntervalSince($0.at) < 90 ? $0 : nil }
        let card = asks[key] ?? answeredHere?.ask ?? staleAsks[key].flatMap { Date().timeIntervalSince($0.at) < 600 ? $0.ask : nil }
        guard let card else { return nil }
        let phase = DecisionPhase.resolve(
            cardToolUseId: card.toolUseId, pendingToolUseId: asks[key]?.toolUseId, answeredHereToolUseId: answeredHere?.ask.toolUseId)
        return (card, phase == .answeredHere ? answeredHere?.outcome : nil, phase)
    }

    /// Reads the question card's data for blocked chats an add-on's host owns, once per change of the chat.
    private func refreshAsks() async {
        guard !demoMode, !captureMode else { return }
        let before = asks
        let hosted = hostProviders
        let blocked = sessions.filter { $0.state == .blocked && $0.alive != false && hosted.contains($0.key.provider) }
        askFetchedAt = askFetchedAt.filter { k, _ in blocked.contains { $0.key == k } }
        for s in blocked where askFetchedAt[s.key] != .some(s.lastActivityAt) {
            askFetchedAt[s.key] = .some(s.lastActivityAt)
            guard let target = s.replyTarget else { continue }
            if let found = try? await client.pendingAsk(conductorSessionId: target) { asks[s.key] = found } else { asks[s.key] = nil }
        }
        // A question that stops being pending (answered in Conductor, on the phone, or by typing) leaves a disabled card.
        asks = asks.filter { k, _ in blocked.contains { $0.key == k } }
        for (k, ask) in before where asks[k]?.toolUseId != ask.toolUseId && answeredAsks[k]?.ask.toolUseId != ask.toolUseId {
            staleAsks[k] = (ask, Date())
        }
        staleAsks = staleAsks.filter { k, d in asks[k] == nil && Date().timeIntervalSince(d.at) < 600 }
        answeredAsks = answeredAsks.filter { _, d in Date().timeIntervalSince(d.at) < 90 }
    }

    /// Delivers an answer. Only ever called from the card's Send button; never retried.
    func answer(_ form: AskForm, for key: SessionKey) async -> AnswerOutcome {
        if demoMode { return .refused(reason: "Demo data: nothing is sent.") }
        guard let target = session(key)?.replyTarget else { return .refused(reason: "Squeak has no way to answer this chat.") }
        let outcome = await client.answer(
            conductorSessionId: target, toolUseId: form.ask.toolUseId,
            answers: form.ask.kind == .question ? form.answers() : nil, plan: form.plan)
        switch outcome {
        case .answered(let via, _): AppLog.info("answer delivered via \(via)")
        case .refused: AppLog.info("answer refused")
        case .uncertain: AppLog.info("answer uncertain")
        }
        if outcome.isAnswered {
            beginOptimistic(key, native: false, answeringBlocked: true)
            askFetchedAt[key] = nil
            answeredAsks[key] = (form.ask, outcome, Date())
        }
        return outcome
    }

    private func refreshNeedsYouText() async {
        let blocked = sessions.filter { $0.state == .blocked && $0.alive != false }
        needsYouFetchedAt = needsYouFetchedAt.filter { k, _ in blocked.contains { $0.key == k } }
        for s in blocked where needsYouFetchedAt[s.key] != .some(s.lastActivityAt) {
            needsYouFetchedAt[s.key] = .some(s.lastActivityAt)
            if let t = await broker.lastAgentText(for: s.key) { needsYouText[s.key] = t }
        }
        needsYouText = needsYouText.filter { k, _ in blocked.contains { $0.key == k } }
    }

    var ordered: OrderedSessions { _ = derivedRevision; return derived.ordered.value(bucket: TimeBucket.of(Date())) { SessionOrdering.order(visibleSessions, pinned: pinned) } }
    var providers: [String] { _ = derivedRevision; return derived.providers.value { Array(Set(sessions.map(\.key.provider))).sorted() } }
    var repos: [String] { _ = derivedRevision; return derived.repos.value { Array(Set(sessions.compactMap(\.repoName))).sorted() } }

    /// Memoized per query until the sessions or any loaded transcript change.
    var searchHits: [SearchHit] {
        _ = derivedRevision
        let q = query
        return derived.search.value(q) { SearchIndex(sessions: sessions, messages: knownMessages).search(q) }
    }

    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    func session(_ key: SessionKey?) -> HostSession? {
        guard let key else { return nil }
        return startedChats.resolve(key, listed: allSessions, now: Date())
    }

    /// Chats just started and not yet in the list: the detail opens on them instead of reading "no longer lists".
    private(set) var startedChats = StartedChats() { didSet { inputsChanged() } }
    func rememberStarted(_ s: HostSession) { startedChats.add(s, at: Date()) }

    var selectedSession: HostSession? { session(selected) }
    var attentionCount: Int { _ = derivedRevision; return derived.attention.value { sessions.filter { ($0.state == .blocked && $0.alive != false) || $0.isLoopingNow }.count } }

    func canSend(_ s: HostSession) -> Bool {
        guard s.capabilities.send.isOffered else { return false }
        return s.replyTarget != nil
    }

    /// Sending is off only because the service isn't answering right now (the chat itself is fine).
    func serviceDown(_ s: HostSession) -> Bool { s.capabilities.send.isServiceUnavailable }

    /// Looks at the service again now (a composer that is open and not ready calls this every few seconds).
    func probeService() {
        guard !demoMode else { return }
        Task { await broker.refresh() }
    }

    var sendableSessions: [HostSession] { ordered.flattened.filter(canSend) }

    // MARK: Selection

    func select(_ key: SessionKey?) {
        if let key { lastWorkspaceSession = key }
        if key != nil { NewChatController.shared.hide() }
        if key != nil, navFilter == .usage { navFilter = .all }
        // Opening a chat from anywhere (a notification, ⌘1…9) leaves Settings.
        if key != nil { closeSettings() }
        guard key != selected else { return }
        if let old = selected { saveDraftNow(draft, for: old) }
        selected = key
        markOpenChatSeen()
        selectedLoadedAt = nil
        transcriptReadKey = nil
        activityReadKey = nil
        activityFeed.reset()
        activity = []
        turnWork = [:]
        openURL = nil
        draft = ""
        messages = key.map { knownMessages[$0] ?? [] } ?? []
        paging = EarlierPaging()
        if demoMode {
            transcriptReadKey = key; activityReadKey = key
            if let key { messages = DemoData.transcript(for: key); activity = DemoData.activity(for: key) }
            return
        }
        Task { [weak self] in
            guard let self else { return }
            guard let key else { await broker.setFocused(nil); return }
            await broker.setFocused(key)
            self.openURL = await broker.openInHostURL(for: key)
            self.draft = await broker.draft(for: key) ?? ""
            _ = publishIfChanged(self, \.messages, await broker.messages(for: key))
            _ = publishIfChanged(self, \.turnWork, await broker.turns(for: key))
            let started = Date()
            await broker.refreshTranscript()
            if self.selected == key { self.paging = await broker.paging(for: key); self.transcriptReadKey = key }
            // Only a transcript read while the source answers counts as what the window shows.
            if self.selected == key, self.transcriptIsLive {
                self.selectedLoadedAt = started
                self.markSelectedDisplayed()
            }
        }
    }

    /// Reads the next older page of the open chat. The broker puts it in front of what is loaded and says so
    /// through `messagesChanged`; one read at a time, a failure stays on the row for a retry.
    func loadEarlier() {
        guard let key = selected, !demoMode, paging.canLoad else { return }
        Task { [broker] in await broker.loadEarlier(for: key) }
    }

    func selectIndex(_ i: Int) {
        let list = ordered.flattened
        guard list.indices.contains(i) else { return }
        select(list[i].key)
    }

    /// The open chat's step feed: one append-only merge of the transcript read and the stream's live step, so a read that
    /// is empty, failed or older than the screen never removes a row (`ActivityFeedMerge`). `incoming` nil = no new read.
    private func mergedActivity(incoming: [ActivityStep]?) -> [ActivityStep] {
        let working = selectedSession.map { effectiveState($0) == .working } ?? false
        let live = native.key == selected ? native.liveStep : nil
        let r = activityFeed.apply(incoming: incoming, live: live, working: working, turn: openTurnId)
        return r.steps
    }

    /// The turn the open chat is in: its newest message's turn, else the person's newest message.
    private var openTurnId: String? {
        for m in displayMessages.reversed() { if let t = m.turnId { return t } }
        return displayMessages.last(where: { $0.role == .user })?.id
    }

    /// The open Squeak chat's feed with the stream's live step after the transcript's own (a long think writes no row).
    func showLiveStep() {
        let shown = mergedActivity(incoming: nil)
        if shown != activity { activity = shown }
    }

    func refreshActivity() async {
        guard let key = selected, !demoMode, pollGate.presence != .hidden else { return }
        let read = try? await broker.activity(for: key)
        guard key == selected else { return }
        activityReadKey = key
        // A failed read says nothing; an empty or older one never shrinks the feed.
        let shown = mergedActivity(incoming: read)
        if shown != activity { activity = shown }
    }

    func recheck() { Task { await broker.refresh() } }

    // MARK: Awake

    /// The Mac's awake session as the daemon last said; nil when none runs.
    private(set) var awake: DaemonAwake? {
        get { awakeStore.awake }
        set { publishIfChanged(awakeStore, \.awake, newValue) }
    }
    private(set) var awakeOffered: Bool {
        get { awakeStore.awakeOffered }
        set { publishIfChanged(awakeStore, \.awakeOffered, newValue) }
    }
    /// Lid-closed sessions are set up (the sudoers rule is in).
    private(set) var awakeLidReady: Bool {
        get { awakeStore.awakeLidReady }
        set { publishIfChanged(awakeStore, \.awakeLidReady, newValue) }
    }
    private(set) var settingUpLid: Bool {
        get { awakeStore.settingUpLid }
        set { publishIfChanged(awakeStore, \.settingUpLid, newValue) }
    }
    private(set) var settingUpFans: Bool {
        get { awakeStore.settingUpFans }
        set { publishIfChanged(awakeStore, \.settingUpFans, newValue) }
    }
    private(set) var settingUpPower: Bool {
        get { awakeStore.settingUpPower }
        set { publishIfChanged(awakeStore, \.settingUpPower, newValue) }
    }
    private(set) var settingPowerMode: Bool {
        get { awakeStore.settingPowerMode }
        set { publishIfChanged(awakeStore, \.settingPowerMode, newValue) }
    }
    private(set) var powerModeNote: String? {
        get { awakeStore.powerModeNote }
        set { publishIfChanged(awakeStore, \.powerModeNote, newValue) }
    }
    /// The Mac's energy mode, and whether its rule is in; nil from an older daemon or a Mac with none.
    private(set) var power: DaemonPower? {
        get { awakeStore.power }
        set { publishIfChanged(awakeStore, \.power, newValue) }
    }
    private(set) var heat: DaemonHeat? {
        get { awakeStore.heat }
        set { publishIfChanged(awakeStore, \.heat, newValue) }
    }
    private(set) var hotspot: DaemonHotspot? {
        get { awakeStore.hotspot }
        set { publishIfChanged(awakeStore, \.hotspot, newValue) }
    }
    /// What a closed lid does (nil from a daemon that does not say), and the rest of the daemon's awake report.
    private(set) var awakeLidActions: DaemonLidActions? {
        get { awakeStore.awakeLidActions }
        set { publishIfChanged(awakeStore, \.awakeLidActions, newValue) }
    }
    /// What a session does with the lid open; nil from a daemon without the two modes.
    private(set) var awakeOpenActions: DaemonOpenActions? {
        get { awakeStore.awakeOpenActions }
        set { publishIfChanged(awakeStore, \.awakeOpenActions, newValue) }
    }
    private(set) var awakeLidClosedNow: Bool {
        get { awakeStore.awakeLidClosedNow }
        set { publishIfChanged(awakeStore, \.awakeLidClosedNow, newValue) }
    }
    private(set) var awakeLastEnd: DaemonAwakeEnd? {
        get { awakeStore.awakeLastEnd }
        set { publishIfChanged(awakeStore, \.awakeLastEnd, newValue) }
    }
    private(set) var awakeSleepProblem: String? {
        get { awakeStore.awakeSleepProblem }
        set { publishIfChanged(awakeStore, \.awakeSleepProblem, newValue) }
    }
    /// The daemon's effective safety floors; nil from an older daemon (the views then say 40 and 10).
    private(set) var awakeRules: DaemonAwakeRules? {
        get { awakeStore.awakeRules }
        set { publishIfChanged(awakeStore, \.awakeRules, newValue) }
    }
    /// Why the last hotspot save or removal did not happen, and whether one is in flight.
    private(set) var hotspotNote: String? {
        get { awakeStore.hotspotNote }
        set { publishIfChanged(awakeStore, \.hotspotNote, newValue) }
    }
    private(set) var savingHotspot: Bool {
        get { awakeStore.savingHotspot }
        set { publishIfChanged(awakeStore, \.savingHotspot, newValue) }
    }
    /// Why the last change to it did not happen, in plain words.
    private(set) var awakeNote: String? {
        get { awakeStore.awakeNote }
        set { publishIfChanged(awakeStore, \.awakeNote, newValue) }
    }
    /// Reads the awake session (and the hotspot) for the menu bar, every 20 seconds for as long as
    /// the app runs: the countdown beside the duck must not wait for the popover to open.
    func pollAwake() async {
        var round = 0
        while !Task.isCancelled {
            await readAwake()
            // The phone can change it too, so it is read again with the awake state.
            if !demoMode { await loadSendDefault() }
            // The phone-call add-on's update shows in the popup like the app's own: look once a minute, not only when
            // Settings is open (the daemon itself checks for a newer add-on every 6 hours).
            if round % 3 == 0, !demoMode { await channels.refreshGateway(); await cloud.refresh() }
            round += 1
            try? await Task.sleep(for: .seconds(20))
        }
    }

    func readAwake() async {
        if demoMode { awakeOffered = true; return }
        let fetched = try? await client.state()
        HeresayBridge.service(reachable: fetched != nil, windowOpen: conversationWindow?.isVisible == true)
        guard let state = fetched else { return }
        if state.awake != awake { awake = state.awake }
        if state.awakeOffered != awakeOffered { awakeOffered = state.awakeOffered }
        if state.awakeLidReady != awakeLidReady { awakeLidReady = state.awakeLidReady }
        if state.hotspot != hotspot { hotspot = state.hotspot }
        if state.heat != heat { heat = state.heat }
        if state.power != power { power = state.power }
        if state.awakeLidActions != awakeLidActions { awakeLidActions = state.awakeLidActions }
        if state.awakeOpenActions != awakeOpenActions { awakeOpenActions = state.awakeOpenActions }
        if state.awakeLidClosedNow != awakeLidClosedNow { awakeLidClosedNow = state.awakeLidClosedNow }
        if state.awakeLastEnd != awakeLastEnd { awakeLastEnd = state.awakeLastEnd }
        if state.awakeSleepProblem != awakeSleepProblem { awakeSleepProblem = state.awakeSleepProblem }
        if state.awakeRules != awakeRules { awakeRules = state.awakeRules }
    }

    /// Saves the iPhone hotspot's name and password (the daemon keeps the password in the Keychain).
    /// An empty password keeps the stored one. True when it was saved.
    @discardableResult
    func saveHotspot(ssid: String, password: String) async -> Bool {
        guard !savingHotspot else { return false }
        let name = ssid.trimmingCharacters(in: .whitespacesAndNewlines)
        let keeps = hotspot?.configured == true && hotspot?.ssid == name
        if let problem = AwakeFormat.hotspotProblem(ssid: name, password: password, keepsPassword: keeps) {
            hotspotNote = problem
            return false
        }
        savingHotspot = true
        defer { savingHotspot = false }
        if demoMode {
            hotspot = DaemonHotspot(configured: true, ssid: name, enabled: true, onHotspot: false)
            hotspotNote = nil
            return true
        }
        hotspotNote = await client.setHotspot(ssid: name, password: password)
        await readAwake()
        return hotspotNote == nil
    }

    /// Forgets the hotspot: its name and the password in the Keychain.
    func removeHotspot() async {
        guard !savingHotspot else { return }
        savingHotspot = true
        defer { savingHotspot = false }
        if demoMode {
            hotspot = DaemonHotspot(configured: false, ssid: nil, enabled: false, onHotspot: false)
            hotspotNote = nil
            return
        }
        hotspotNote = await client.clearHotspot()
        await readAwake()
    }

    /// Turns one thing a session does with the lid open on or off. Shown at once, then confirmed by the daemon.
    func setOpenAction(_ key: String, _ on: Bool) async {
        func set(_ a: inout DaemonOpenActions) {
            switch key {
            case "screenOn": a.screenOn = on
            case "mute": a.mute = on
            case "lowPower": a.lowPower = on
            default: a.freezeApps = on
            }
        }
        if demoMode {
            var a = awakeOpenActions ?? DaemonOpenActions()
            set(&a)
            awakeOpenActions = a
            return
        }
        let before = awakeOpenActions
        if var a = awakeOpenActions { set(&a); awakeOpenActions = a }
        if let problem = await client.setLidActions([key: on], open: true) {
            awakeOpenActions = before
            awakeNote = problem
        } else {
            awakeNote = nil
        }
        await readAwake()
    }

    /// Turns one thing a closed lid does on or off. Shown at once, then confirmed by the daemon's next report.
    func setLidAction(_ key: String, _ on: Bool) async {
        if demoMode {
            var a = awakeLidActions ?? DaemonLidActions()
            switch key {
            case "displayOff": a.displayOff = on
            case "mute": a.mute = on
            case "lowPower": a.lowPower = on
            default: a.freezeApps = on
            }
            awakeLidActions = a
            return
        }
        let before = awakeLidActions
        if var a = awakeLidActions {
            switch key {
            case "displayOff": a.displayOff = on
            case "mute": a.mute = on
            case "lowPower": a.lowPower = on
            default: a.freezeApps = on
            }
            awakeLidActions = a
        }
        if let problem = await client.setLidActions([key: on]) {
            awakeLidActions = before
            awakeNote = problem
        } else {
            awakeNote = nil
        }
        await readAwake()
    }

    /// Demo captures only: the awake state a screenshot should show.
    func installDemoAwake(
        _ awake: DaemonAwake?, lidReady: Bool, actions: DaemonLidActions? = DaemonLidActions(),
        openActions: DaemonOpenActions? = DaemonOpenActions(screenOn: true), end: DaemonAwakeEnd? = nil,
        hotspot: DaemonHotspot? = nil, sleepProblem: String? = nil, rules: DaemonAwakeRules? = nil
    ) {
        guard demoMode else { return }
        awakeOffered = true
        self.awake = awake
        awakeLidReady = lidReady
        awakeLidActions = actions
        awakeOpenActions = openActions
        awakeLastEnd = end
        self.hotspot = hotspot
        awakeSleepProblem = sleepProblem
        awakeRules = rules
    }

    /// "start" (minutes nil: until ended), "extend" or "end".
    func changeAwake(_ action: String, minutes: Int? = nil, lid: Bool = false) async {
        awakeNote = await client.changeAwake(action: action, minutes: minutes, lid: lid)
        await readAwake()
    }

    /// Installs the lid-closed rule with macOS's admin prompt, once per Mac.
    func setUpLidClosed() async {
        guard !settingUpLid, !demoMode else { return }
        settingUpLid = true
        defer { settingUpLid = false }
        guard let rule = await client.lidRule() else {
            awakeNote = "This version of the Squeak service can't set up lid closed. Update it first."
            return
        }
        switch await LidRule.install(rule) {
        case .installed:
            await client.recheckLidRule()
            await readAwake()
            awakeNote = awakeLidReady ? "Lid closed is ready. Start a session and your Mac stays awake with the lid shut." : "Installed, but Squeak can't use it yet. Try again in a moment."
        case .cancelled: awakeNote = nil
        case .failed(let reason): awakeNote = "Lid closed wasn't set up. \(reason)"
        }
    }

    /// Installs the energy mode rule with macOS's admin prompt, once per Mac.
    func setUpPower() async {
        guard !settingUpPower, !demoMode else { return }
        settingUpPower = true
        defer { settingUpPower = false }
        guard let rule = await client.powerRule() else {
            awakeNote = "This version of the Squeak service can't set the energy mode. Update it first."
            return
        }
        switch await PowerRule.install(rule) {
        case .installed:
            await client.recheckPower()
            await readAwake()
            awakeNote = power?.ready == true
                ? "Energy mode is ready. Pick Automatic, Low Power or High Power from Mac controls on your iPhone."
                : "Installed. Squeak picks it up within a few seconds."
        case .cancelled: awakeNote = nil
        case .failed(let reason): awakeNote = "Energy mode wasn't set up. \(reason)"
        }
    }

    /// Applies a choice through the daemon's existing energy-mode guard and refreshes `/state` afterward.
    func setPowerMode(_ choice: String) async {
        guard !settingPowerMode, !demoMode else { return }
        settingPowerMode = true
        defer { settingPowerMode = false }
        powerModeNote = await client.setPowerMode(choice)
        await readAwake()
    }

    /// Installs fan control (the root-owned helper and its rule) with macOS's admin prompt, once per Mac.
    func setUpFanControl() async {
        guard !settingUpFans, !demoMode else { return }
        settingUpFans = true
        defer { settingUpFans = false }
        guard let rule = await client.fanRule() else {
            awakeNote = "This version of the Squeak service can't control the fans. Update it first."
            return
        }
        switch await FanRule.install(rule) {
        case .installed:
            await client.recheckFans()
            await readAwake()
            awakeNote = heat?.fanControl == true
                ? "Fan control is ready. When your Mac warms up during a session, its fans go to full."
                : "Installed. Squeak picks it up within a few seconds."
        case .cancelled: awakeNote = nil
        case .failed(let reason): awakeNote = "Fan control wasn't set up. \(reason)"
        }
    }

    // MARK: Usage

    /// Both readings, from /state; the cost is the sum of today's sessions. Nil until first read.
    private(set) var usage: UsageSnapshot? {
        get { usageStore.usage }
        set { publishIfChanged(usageStore, \.usage, newValue) }
    }
    private(set) var claudeRefreshing: Bool {
        get { usageStore.claudeRefreshing }
        set { publishIfChanged(usageStore, \.claudeRefreshing, newValue) }
    }
    /// Why the last Refresh did not produce a new reading, in plain words; nil otherwise.
    private(set) var claudeRefreshNote: String? {
        get { usageStore.claudeRefreshNote }
        set { publishIfChanged(usageStore, \.claudeRefreshNote, newValue) }
    }
    @ObservationIgnored private var claudeRefreshedAt: Date?

    /// The saved Claude accounts (claude-swap), only while the daemon says it can switch; nil hides the row.
    private(set) var claudeAccounts: ClaudeAccountList? {
        get { usageStore.claudeAccounts }
        set { publishIfChanged(usageStore, \.claudeAccounts, newValue) }
    }
    private(set) var claudeSwitching: Bool {
        get { usageStore.claudeSwitching }
        set { publishIfChanged(usageStore, \.claudeSwitching, newValue) }
    }
    /// Why the last switch did not happen, or what it did, in plain words.
    private(set) var claudeAccountNote: String? {
        get { usageStore.claudeAccountNote }
        set { publishIfChanged(usageStore, \.claudeAccountNote, newValue) }
    }
    @discardableResult
    func readClaudeAccounts() async -> Bool {
        if demoMode { return false }
        let list = try? await client.claudeAccounts()
        let next = (list?.available ?? false) ? list : nil
        return publishIfChanged(self, \.claudeAccounts, next)
    }

    /// Switches Claude to a saved account (the person already confirmed). New chats use it; chats already running
    /// keep the old one until they restart. Then asks for a fresh usage reading, which now reports the new account.
    func switchClaudeAccount(_ name: String) async {
        guard !claudeSwitching else { return }
        claudeSwitching = true
        claudeAccountNote = nil
        defer { claudeSwitching = false }
        do {
            switch try await client.useClaudeAccount(name) {
            case .switched:
                claudeAccountNote = "Switched. New chats use \(name); chats already running keep the old account until they restart."
                await readClaudeAccounts()
                await refreshClaude()
            case .refused(let reason): claudeAccountNote = reason
            case .outdated: claudeAccountNote = "This version of the Squeak service can't switch accounts. Update it first."
            }
        } catch {
            claudeAccountNote = "Couldn't reach Squeak to switch. Check the connection and try again."
        }
    }

    @discardableResult
    func readUsage() async -> Bool {
        if demoMode { return publishIfChanged(self, \.usage, DemoData.usage()) }
        guard let state = try? await client.state() else { return false }
        return publishIfChanged(self, \.usage, state.usage())
    }

    /// Re-reads while a usage view is on screen. Codex's reading is live; Claude's changes only
    /// when Refresh is pressed (or Squeak's own chat asks a question).
    func pollUsage() async {
        await PollLoop.run(gate: pollGate, base: { 15 }, max: 60) {
            let a = await self.readUsage()
            let b = await self.readClaudeAccounts()
            return a || b
        }
    }

    /// Takes one fresh Claude reading. Only ever called from the user pressing Refresh: it reads the
    /// plan's usage from Claude without using any tokens, and may prompt for Keychain access, so it
    /// never runs on a timer.
    func refreshClaude() async {
        guard !claudeRefreshing else { return }
        claudeRefreshing = true
        claudeRefreshNote = nil
        defer { claudeRefreshing = false }
        if demoMode {
            try? await Task.sleep(for: .seconds(1))
            if var u = usage, var c = u.claude { c.observedAt = Date(); u.claude = c; usage = u }
            return
        }
        do {
            guard let result = try await client.refreshClaudeUsage() else {
                claudeRefreshNote = "This version of the Squeak service can't refresh Claude's reading. Update it first."
                return
            }
            if var u = usage { u.claude = result.claude ?? u.claude; usage = u } else { await readUsage() }
            if let error = result.error {
                claudeRefreshNote = error
            } else if result.throttled {
                claudeRefreshNote = "Just refreshed. Squeak checks Claude's usage at most once a minute."
            } else if !result.refreshed {
                claudeRefreshNote = "Claude did not report its limits this time."
            }
        } catch AdapterError.timedOut {
            claudeRefreshNote = "Claude took too long to report its usage."
        } catch {
            claudeRefreshNote = "Couldn't reach Squeak to refresh. Check the connection and try again."
        }
    }

    // MARK: Drafts

    /// Before any quit: the quick composer's text and the open chat's draft (its write is debounced 600 ms) reach disk,
    /// waiting at most 1 s.
    func flushDraftsForQuit() {
        draftTask?.cancel()
        let quick = QuickComposerController.shared.state.quitWrite()
        let chat: (key: SessionKey, text: String)? = selected.map { ($0, draft) }
        DraftFlush.waitFor(timeout: 1) { [broker] in
            if let chat { await broker.setDraft(chat.text, for: chat.key) }
            await quick?()
        }
    }

    func setDraft(_ text: String) {
        draft = text
        guard let key = selected else { return }
        draftTask?.cancel()
        draftTask = Task { [broker] in
            try? await Task.sleep(for: .milliseconds(600))
            if !Task.isCancelled { await broker.setDraft(text, for: key) }
        }
    }

    private func saveDraftNow(_ text: String, for key: SessionKey) {
        draftTask?.cancel()
        Task { [broker] in await broker.setDraft(text, for: key) }
    }

    // MARK: Sending (only ever on an explicit user action)

    /// `answering`: the text answers what the agent last said (a lettered option), so a host that checks is
    /// told which turn, and refuses it once the chat has moved on.
    func send(
        _ text: String, to key: SessionKey, mode: SendMode = .queue, answering: Bool = false, clearsDraft: Bool = true
    ) async -> SendResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if demoMode { return .notSent(reason: "Demo data: nothing is sent.") }
        lastUsed = key
        defaults.set(key.stringValue, forKey: "lastUsed")
        let clearsDraft = DraftPolicy.clearsDraft(answering: answering, requested: clearsDraft)
        if key == selected, clearsDraft { draftTask?.cancel(); draft = "" }
        let turn = answering ? await broker.currentTurnId(for: key) : nil
        // The chat reads working the instant Send is pressed, before any word from the host.
        let target = session(key)
        let midTurn = target.map { effectiveState($0) == .working } ?? false
        if !midTurn { beginOptimistic(key, native: target?.source == .squeak, answeringBlocked: target?.state == .blocked) }
        // The watchdog and the timings start at the press, not once the POST has come back.
        let sentAtPress = ContinuousClock.now
        if target?.source == .squeak, native.key == key {
            native.watchdog.noteSend(at: Date())
            native.sendStart = sentAtPress
            native.firstEventLogged = false
            AppLog.timing("send pressed")
        }
        // A message sent while a Squeak chat works is a card in the queue stack, not a bubble in the transcript.
        var localCard: String?
        if midTurn, target?.source == .squeak, native.key == key {
            localCard = UUID().uuidString
            native.pending.beginLocal(id: localCard!, text: trimmed, steer: mode == .steer, at: Date())
        }
        // A queued message to a working chat an add-on's host owns shows in its queue at once, before the daemon answers.
        var card: (store: QueueStore, id: String)?
        if mode == .queue, let s = session(key), hostProviders.contains(s.key.provider), s.state == .working {
            let store = queueStore(for: key.hostSessionId)
            card = (store, store.beginPending(text: trimmed))
        }
        let result = await broker.send(trimmed, to: key, mode: mode, answersTurn: turn, echoes: localCard == nil, keepsDraft: !clearsDraft)
        if let localCard {
            switch result {
            case .accepted(_, let delivery, _): native.pending.settleLocal(id: localCard, accepted: true, queued: delivery == .queued)
            case .uncertain: native.pending.settleLocal(id: localCard, accepted: true, queued: true)
            case .refused, .notSent: native.pending.settleLocal(id: localCard, accepted: false, queued: false)
            }
            if let s = target, case .accepted = result { await refreshNativePending(s) }
        }
        // A send that did not go: the chat is not working after all.
        switch result {
        case .refused, .notSent: if !midTurn { optimistic[key] = nil }
        default: break
        }
        if let card {
            switch result {
            case .accepted:
                Task { await card.store.accepted(card.id, sessionId: key.hostSessionId) }
            case .uncertain(let reason): card.store.failed(card.id, reason: reason, unclear: true)
            case .refused(let reason), .notSent(let reason): card.store.failed(card.id, reason: reason, unclear: false)
            }
        }
        switch result {
        case .accepted(let via, let delivery, _):
            AppLog.info("send accepted via \(via), \(delivery?.rawValue ?? "sent")")
            AppLog.timing("send host accepted \(Self.ms(since: sentAtPress)) ms")
            // A preset picked in this chat has its split in front of this message now.
            if session(key)?.source == .squeak {
                ChatSplitStore().messageSent(chat: key.stringValue)
            }
        case .refused: AppLog.info("send refused")
        case .uncertain: AppLog.info("send uncertain"); HeresayBridge.trouble()
        case .notSent: AppLog.info("send not sent"); HeresayBridge.trouble()
        }
        // Nothing left our hands: the words go back to the draft so they are never lost.
        switch result {
        case .refused, .notSent:
            // With a card in the queue, its Retry and Edit hold the words.
            if card == nil, clearsDraft, key == selected, draft.isEmpty { setDraft(text) }
        default: break
        }
        return result
    }

    // MARK: Working from the press

    func beginOptimistic(_ key: SessionKey, native isNative: Bool, answeringBlocked: Bool = false) {
        guard optimistic[key]?.isStarted != true else {
            noteOptimistic(key) { $0.begin(at: Date(), baselineSeq: isNative && native.key == key ? native.lastSeq : nil, answeringBlocked: answeringBlocked) }
            return
        }
        var work = OptimisticWork()
        work.begin(at: Date(), baselineSeq: isNative && native.key == key ? native.lastSeq : nil, answeringBlocked: answeringBlocked)
        optimistic[key] = work
        // Nothing else re-draws at the cap: take it back then.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(OptimisticWork.cap + 0.5))
            guard let self, let sent = optimistic[key]?.sentAt, Date().timeIntervalSince(sent) >= OptimisticWork.cap else { return }
            optimistic[key] = nil
        }
    }

    /// The press of Stop: the chat no longer reads working on our word alone.
    func endOptimistic(_ key: SessionKey) { if optimistic[key] != nil { optimistic[key] = nil } }

    /// A native chat's status from its stream, in the sidebar at once (the catalog read it triggers lands later).
    func applyHostStatus(_ key: SessionKey, _ state: SessionState) {
        guard let i = hostSessions.firstIndex(where: { $0.key == key }), hostSessions[i].state != state else { return }
        hostSessions[i].state = state
    }

    /// The state the chat shows: the host's, but working from the moment of a send newer than what the host last said.
    func effectiveState(_ s: HostSession) -> SessionState {
        guard let work = optimistic[s.key] else { return s.state }
        return work.resolve(host: s.state, now: Date())
    }

    /// A host event about a chat we sent to (message rows and statuses by seq, catalog states for the rest).
    func noteOptimistic(_ key: SessionKey, _ change: (inout OptimisticWork) -> Void) {
        guard var work = optimistic[key] else { return }
        change(&work)
        optimistic[key] = work.isStarted ? work : nil
    }

    /// Sends a failed bubble's words again (the failed bubble goes; the draft the failure restored is cleared).
    func retryFailed(_ message: ChatMessage) {
        guard let key = selected else { return }
        Task { [weak self] in
            guard let self else { return }
            await broker.discardFailed(id: message.id, in: key)
            if draft == message.text { setDraft("") }
            _ = await send(message.text, to: key, mode: .queue)
        }
    }

    /// Sends a failed queue card again (only ever one that was not sent).
    func retryPending(_ item: PendingQueueItem, sessionId: String) {
        guard let key = sessions.first(where: { $0.key.hostSessionId == sessionId })?.key else { return }
        queueStore(for: sessionId).dismissPending(item.id)
        Task { _ = await send(item.text, to: key, mode: .queue) }
    }

    /// Reads the shared queue/steer default; a failure says why the Settings picker is off.
    func loadSendDefault() async {
        if demoMode || captureMode { sendDefaultLoad = .ready; return }
        do {
            if let mode = try await client.sendDefault() {
                sendDefault = SendDefault(mode)
                sendDefaultLoad = .ready
            } else {
                sendDefaultLoad = .unavailable("Update the Squeak service on this Mac to choose this.")
            }
        } catch {
            sendDefaultLoad = .unavailable("Squeak isn't running, so this can't be read or saved.")
        }
    }

    func setSendDefault(_ mode: SendMode) async {
        let before = sendDefault
        sendDefault = SendDefault(mode)
        if demoMode || captureMode { return }
        if let saved = try? await client.setSendDefault(mode) { sendDefault = SendDefault(saved) } else { sendDefault = before }
    }

    /// Puts a refused or unsent message back in the composer. Never sends.
    func reuse(_ message: ChatMessage) {
        guard selected != nil else { return }
        setDraft(message.text)
    }

    // MARK: Notification context (the quick composer's reading side; never touches the open conversation)

    /// `anchor` with whatever its event's capture learned after the notification was posted.
    func resolvedAnchor(_ anchor: NotificationAnchor?) -> NotificationAnchor? { anchor.map(anchorLog.resolve) }

    /// What is on hand without asking anyone: the context cache and any transcript already read.
    func cachedContextMessages(for key: SessionKey) async -> [ChatMessage] {
        if demoMode { return DemoData.transcript(for: key) }
        let saved = (try? await contextCache?.messages(for: key)) ?? []
        return NotificationContextPolicy.merge(cached: saved, live: knownMessages[key] ?? [])
    }

    /// Reads the chat's transcript now, outside the conversation window's focus. A click that
    /// arrives on a cold launch waits (briefly) for the first catalog rather than calling the chat gone.
    func liveContextMessages(for key: SessionKey) async -> TranscriptRead {
        if demoMode { return .messages(DemoData.transcript(for: key), fetchedAt: Date()) }
        var waits = 0
        while !hasLoaded, waits < 40, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(200))
            waits += 1
        }
        guard hasLoaded else { return .offline }
        return await broker.readTranscript(for: key)
    }

    /// Keeps what a displayed context showed, so the same notification opens the same reply later.
    func rememberContext(_ content: NotificationContextContent, for key: SessionKey) async {
        guard content.confidence != .unavailable, !content.cacheable.isEmpty else { return }
        try? await contextCache?.putMessages(content.cacheable, for: key)
    }

    /// True only when the host app was really handed the chat: no URL, or a refusal, is false and
    /// callers keep their context. Demo and capture runs never open anything.
    func openInHost(_ key: SessionKey) async -> Bool {
        guard !demoMode, !captureMode, let url = await broker.openInHostURL(for: key) else { return false }
        return NSWorkspace.shared.open(url)
    }

    // MARK: Menu previews

    /// Excerpts of the newest reply for the few finished or errored sessions the menu lists. At most
    /// six, recent ones only, each read once per change of the chat (a failed read waits a minute),
    /// from a short transcript tail that leaves the conversation window's focus alone.
    func refreshMenuPreviews() async {
        guard !previewsRefreshing else { return }
        previewsRefreshing = true
        defer { previewsRefreshing = false }
        let now = Date()
        let eligible = sessions
            .filter { ($0.state == .finished || $0.state == .error) && now.timeIntervalSince($0.lastActivityAt ?? .distantPast) < 6 * 3600 }
            .sorted { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }
            .prefix(6)
        var out = menuReplyPreviews.filter { k, _ in eligible.contains { $0.key == k } }
        previewFetches = previewFetches.filter { k, _ in eligible.contains { $0.key == k } }
        for s in eligible {
            if demoMode {
                if let t = DemoData.transcript(for: s.key).last(where: { $0.role == .assistant })?.text { out[s.key] = NotificationContextPolicy.excerpt(t) }
                continue
            }
            if let last = previewFetches[s.key], last.activity == s.lastActivityAt, last.ok || now.timeIntervalSince(last.tried) < 60 { continue }
            // A transcript the window already read is current if it is not older than the chat's activity.
            if let m = knownMessages[s.key]?.last(where: { $0.role == .assistant && !$0.text.isEmpty }),
               let at = m.at, let activity = s.lastActivityAt, at.addingTimeInterval(5) >= activity {
                out[s.key] = NotificationContextPolicy.excerpt(m.text)
                previewFetches[s.key] = (s.lastActivityAt, now, true)
                continue
            }
            let text = await broker.lastAgentText(for: s.key)
            previewFetches[s.key] = (s.lastActivityAt, now, text != nil)
            if let text { out[s.key] = NotificationContextPolicy.excerpt(text) }
        }
        if out != menuReplyPreviews { menuReplyPreviews = out }
    }

    // MARK: Pins, windows

    func togglePin(_ key: SessionKey) {
        if pinned.contains(key) { pinned.remove(key) } else { pinned.insert(key) }
        defaults.set(pinned.map(\.stringValue).sorted(), forKey: "pinned")
    }

    func showConversationWindow() {
        dismissMenuBar?()
        ActivationPolicyController.shared.showWindowWhenReady { [weak self] in
            self?.openConversationWindow?()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.recomputeVisibility() }
        }
    }

    /// Shows update progress where the person already is (`UpdateDestination`): Settings if it is on screen, else the
    /// sidebar card in the conversation window, opening that window when nothing of Squeak is open.
    func showUpdateWhereThePersonIs() {
        let visible = conversationWindow?.isVisible == true
        let settingsOpen = visible && settingsSection != nil
        // Settings is a mode of the one window, so when it shows it is also what was last in front.
        switch UpdateDestination.decide(settingsOpen: settingsOpen, settingsWasLastKey: settingsOpen,
                                        conversationOpen: visible, panelOpen: dismissMenuBar != nil) {
        case .settings:
            openSettings(.about)
        case .conversationCard:
            showConversationWindow()
        case .openConversation:
            if settingsSection != nil { closeSettings() }
            showConversationWindow()
        }
        updater.highlightUpdateCard()
    }

    func open(_ key: SessionKey) {
        dismissMenuBar?()
        select(key)
        showConversationWindow()
    }

    func openInHost() {
        if let openURL { NSWorkspace.shared.open(openURL) }
    }

    /// Settings is a mode of the main window: the page on screen, or nil while it shows sessions.
    /// Leaving and coming back keeps the sidebar filter and the open chat, which Settings never touches.
    var settingsSection: SettingsSection?
    /// One-time destination requested by the phone-call setup checklist.
    var voiceSettingsTarget: VoiceSettingsTarget?
    /// The page the next visit starts on, so reopening Settings lands where it was left.
    @ObservationIgnored private var lastSettingsSection: SettingsSection = .general

    /// The sidebar's "Finish setting up" card is open (the `setup` deep link opens it).
    var setupCardExpanded = false

    /// Opens Settings with the "Finish setting up" card expanded, on the page last visited.
    func openSettingsSetup() {
        setupCardExpanded = true
        openSettings()
    }

    /// Opens the main window on a Settings page (⌘, , the menu-bar panel, the sidebar's Settings row).
    func openSettings(_ section: SettingsSection? = nil) {
        NewChatController.shared.hide()
        settingsSection = section ?? lastSettingsSection
        showConversationWindow()
    }

    /// Switches the page without opening a window (captures, which host the window themselves).
    func openSettingsInPlace(_ section: SettingsSection) {
        NewChatController.shared.hide()
        settingsSection = section
    }

    /// Shows the permission explainer in the conversation window (a menu-bar tip's destination).
    func openPermission(_ kind: PermissionKind) {
        NewChatController.shared.hide()
        permissionSheet = kind
        showConversationWindow()
    }

    func closeSettings() {
        if let s = settingsSection { lastSettingsSection = s }
        settingsSection = nil
    }

    // MARK: Launch at login

    func answerLaunchOffer(enable: Bool) {
        defaults.set(true, forKey: "launchOffered")
        launchOfferPending = false
        if enable { try? LoginItem.set(true) }
    }

    // MARK: Privacy

    func purgeCache() async {
        do {
            try await cache?.purge()
            try await contextCache?.purge()
            knownMessages = [:]
            cacheNotice = "Cache deleted. Squeak will rebuild it as you open conversations."
        } catch {
            cacheNotice = "Couldn't delete the cache: \(error.localizedDescription)"
        }
    }

    // MARK: Updates

    /// "Updated to 2.x", shown in the panel after a relaunch into a new version until dismissed.
    private(set) var updateNote: String?

    func dismissUpdateNote() { updateNote = nil }

    func installDemoUpdateNote(_ note: String) {
        guard demoMode else { return }
        updateNote = note
    }

    /// Written as the app quits for an update: what is open, so the next launch can put it back.
    /// The open chat's draft is saved with it (drafts live in the cache, not in the marker).
    func saveUpdateRestore(restartAttempt: Bool = false) {
        guard !demoMode, !captureMode else { return }
        if let selected { saveDraftNow(draft, for: selected) }
        let window: UpdateRestoreMarker.Window
        if settingsSection != nil { window = .settings }
        else if NSApp.windows.contains(where: { ActivationPolicyController.isAppWindow($0) && $0.title == "Squeak" }) { window = .conversation }
        else if OnboardingController.shared.isShowing { window = .welcome }
        else { window = .none }
        let marker = UpdateRestoreMarker(
            fromVersion: Self.appVersion, window: window, session: selected?.stringValue,
            settingsSection: settingsSection?.rawValue,
            restartAttempt: restartAttempt ? true : nil, restartTarget: restartAttempt ? updater.flow.knownVersion : nil)
        defaults.set(marker.encoded(), forKey: UpdateRestoreMarker.defaultsKey)
    }

    /// First launch of a new version: say so, and reopen what the update closed.
    private func restoreAfterUpdate() async {
        guard !captureMode else { return }
        let current = Self.appVersion
        let change = VersionChange.detect(lastRun: defaults.string(forKey: "lastRunVersion"), current: current)
        defaults.set(current, forKey: "lastRunVersion")
        let marker = UpdateRestoreMarker.decode(defaults.data(forKey: UpdateRestoreMarker.defaultsKey))
        defaults.removeObject(forKey: UpdateRestoreMarker.defaultsKey)
        UpdateLog.standard.write("launch: version \(current), change=\(change), marker=\(marker.map { "restartAttempt=\($0.restartAttempt == true)" } ?? "none")")
        if let marker, marker.restartDidNotApply(currentVersion: current) {
            // "Restart to update" quit the app and it came back on the same version: the install did not happen.
            updater.restartDidNotApply(target: marker.restartTarget, running: current)
        }
        // Remembered across launches: an in-place install was refused here, so updates lead with Download update.
        updater.restoreInPlaceDenial(change: change, marker: marker, current: current)
        guard case .updated = change else { return }
        updateNote = "Updated to \(current)"
        guard let marker = marker?.usable(currentVersion: current), marker.window != .none else { return }
        if let raw = marker.session, let key = SessionKey(stringValue: raw) { select(key) }
        // The window action is wired by the menu-bar label a moment after launch.
        for _ in 0..<20 where openConversationWindow == nil { try? await Task.sleep(for: .milliseconds(100)) }
        switch marker.window {
        case .conversation: showConversationWindow()
        case .settings: openSettings(marker.settingsSection.flatMap(SettingsSection.init(rawValue:)))
        case .welcome: if !onboardingDone { OnboardingController.shared.show() }
        case .none: break
        }
        AppLog.info("updates: restored \(marker.window.rawValue) after update from \(marker.fromVersion)")
    }

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "2.0.0-dev"
    }

    // MARK: Connections and diagnostics

    var connectionsReport: ConnectionsReport {
        ConnectionsReport.make(
            addonRows: enabledApps.flatMap { $0.connectionRows(health: adapterHealths) },
            daemonHealth: adapterHealths["daemon"],
            tokenPresent: tokenPresent)
    }

    func diagnosticsText() -> String {
        var names = ["daemon": "Squeak service"]
        for app in enabledApps { names.merge(app.adapterNames) { a, _ in a } }
        let adapters = adapterHealths.keys.sorted().map { id in
            let h = adapterHealths[id]!
            return DiagnosticsInput.Adapter(name: names[id] ?? "adapter", status: DiagnosticsInput.describe(h.status), lastSyncedAt: h.lastSyncedAt)
        }
        return DiagnosticsReport.render(DiagnosticsInput(
            appVersion: Self.appVersion,
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            adapters: adapters,
            stateCounts: DiagnosticsInput.counts(of: sessions),
            lastUpdateCheck: updater.lastCheck,
            logLines: AppLog.buffer.last(50),
            updateLogLines: UpdateLog.standard.tail(80)))
    }

    func copyDiagnostics() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(diagnosticsText(), forType: .string)
        AppLog.info("diagnostics copied")
    }

    // MARK: Connection wording

    /// An add-on's chats can be read straight from its host's files, so a stopped daemon
    /// costs sending and terminal sessions, not the chat list.
    private var readingDirectly: Bool { ownSourcesConnected && effectiveStatusIsDaemonDown }
    private var effectiveStatusIsDaemonDown: Bool { adapterHealths["daemon"]?.status == .daemonDown }
    /// An enabled add-on's own source answered on the last poll.
    private var ownSourcesConnected: Bool {
        enabledApps.contains { app in app.adapterNames.keys.contains { adapterHealths[$0]?.status == .connected } }
    }

    var connectionTitle: String {
        switch effectiveStatus {
        case .connected: "Connected"
        case .daemonDown: readingDirectly ? "Reading only" : "Squeak service is off"
        case .tokenMissing: "Access token missing"
        case .degraded(let r): hasLoaded || health != nil ? "Trouble connecting" : r
        }
    }

    var connectionHelp: String? {
        switch effectiveStatus {
        case .connected: nil
        case .daemonDown where readingDirectly:
            "Chats are read directly from their app, so they stay up to date. Replying and terminal sessions need Squeak's background service, which isn't running. Start it with “launchctl kickstart -k gui/$(id -u)/com.squeak.daemon” in Terminal."
        case .daemonDown:
            "Squeak's background service isn't running, so sessions can't update or be answered. Start it with “launchctl kickstart -k gui/$(id -u)/com.squeak.daemon” in Terminal. This app reconnects by itself."
        case .tokenMissing:
            "Squeak can't find its access token (Application Support/squeak/hook-token). Start the Squeak service once so it creates the token. Until then you can read sessions but not reply."
        case .degraded(let r):
            "\(r). Squeak keeps showing the last sessions it saw and keeps trying."
        }
    }

    var lastSyncedText: String? {
        guard let d = health?.lastSyncedAt else { return nil }
        return "Last updated " + d.formatted(.relative(presentation: .named))
    }
}

/// Resumes a continuation exactly once, from whichever of two tasks gets there first.
private final class Once<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?
    init(_ c: CheckedContinuation<T, Never>) { continuation = c }

    func fire(_ value: T) {
        let c = lock.withLock { () -> CheckedContinuation<T, Never>? in
            defer { continuation = nil }
            return continuation
        }
        c?.resume(returning: value)
    }
}
