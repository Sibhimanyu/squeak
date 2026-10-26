import AppKit
import Observation
import SqueakMacCore
import SwiftUI

enum SessionFilter: Hashable {
    case all
    case provider(String)
    case repo(String)
}

/// The sidebar's filters: sections of the list, or where a session runs.
enum NavFilter: Hashable {
    case all, needsYou, working, done
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
    let broker: Broker
    let cache: EncryptedCache?
    let captureMode: Bool
    /// SQUEAK_MAC_DEMO=1: made-up sessions, no network, no sends (see DemoData.swift).
    let demoMode: Bool
    /// Settings › Channels and › iPhone. Demo and capture runs never touch the real `.env` or daemon.
    @ObservationIgnored lazy var channels = ChannelsModel(client: client, demo: demoMode || captureMode)
    /// The background service Squeak installs and updates for installs without a checkout (DaemonManager.swift).
    @ObservationIgnored lazy var daemon = DaemonManager(enabled: !(demoMode || captureMode))
    @ObservationIgnored var openConversationWindow: (() -> Void)?
    /// Closes the menu-bar panel; installed by its controller. Called before focus moves to a window.
    @ObservationIgnored var dismissMenuBar: (() -> Void)?
    /// The window that hosts `ConversationView`, registered by the view itself.
    @ObservationIgnored weak var conversationWindow: NSWindow?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var visibilityTokens: [NSObjectProtocol] = []

    // MARK: Catalog and connection
    private(set) var sessions: [HostSession] = []
    private(set) var health: AdapterHealth?
    private(set) var hasLoaded = false
    private(set) var tokenPresent = true
    private(set) var firstConnectionSeen = false
    private(set) var adapterHealths: [String: AdapterHealth] = [:]
    /// False when conductor.db is missing and the daemon serves Conductor chats too.
    let usesLocalConductor: Bool

    // MARK: Updates (Sparkle installs them; see Updater.swift)
    let updater = AppUpdater()

    // MARK: Selection and conversation
    private(set) var selected: SessionKey?
    private(set) var messages: [ChatMessage] = []
    /// How far back the open chat has been read, for the row at the top of the conversation.
    private(set) var paging = EarlierPaging()
    private(set) var activity: [ActivityStep] = []
    /// The open Conductor chat's model, stuck state, workspace and background work, from the daemon (ChatActions.swift).
    var chatExtras: ChatExtras?
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
    @ObservationIgnored private var askFetchedAt: [SessionKey: Date?] = [:]
    @ObservationIgnored private var needsYouFetchedAt: [SessionKey: Date?] = [:]
    @ObservationIgnored private var knownMessages: [SessionKey: [ChatMessage]] = [:]
    @ObservationIgnored private var draftTask: Task<Void, Never>?
    /// When the open conversation's transcript was last read; what it shows is no newer than this.
    @ObservationIgnored private var selectedLoadedAt: Date?

    // MARK: Updates the user has not seen, and the menu's reply excerpts
    /// Event ids and times per chat (no text), kept until content that includes the event is displayed.
    private(set) var unread: UnreadTracker
    /// A short excerpt of the newest reply for recent finished and errored sessions, for the menu.
    private(set) var menuReplyPreviews: [SessionKey: String] = [:]
    @ObservationIgnored private var anchorLog: NotificationAnchorLog
    @ObservationIgnored private var previewFetches: [SessionKey: (activity: Date?, tried: Date, ok: Bool)] = [:]
    @ObservationIgnored private var previewsRefreshing = false
    /// Replies that notifications were about, kept apart from the conversation cache so a click
    /// after a relaunch still opens on its own reply. Encrypted like the cache; nil in demo and capture runs.
    @ObservationIgnored let contextCache: EncryptedCache?

    // MARK: Browsing
    var query = ""
    var filter: SessionFilter = .all
    var navFilter: NavFilter? = .all {
        // Usage is a screen of its own, so no chat stays open behind it; picking a chat leaves it.
        didSet { if navFilter == .usage, selected != nil { select(nil) } }
    }
    /// A short live phrase per working session ("Running tests"), for the list rows.
    private(set) var liveSteps: [SessionKey: String] = [:]
    private(set) var pinned: Set<SessionKey>

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
    /// Wakes the broker the moment Conductor writes its database, in either poll mode.
    @ObservationIgnored private var databaseWatcher: FileChangeWatcher?

    init() {
        let env = ProcessInfo.processInfo.environment
        captureMode = env["SQUEAK_MAC_CAPTURE"] != nil
        demoMode = env["SQUEAK_MAC_DEMO"] == "1"
        client = DaemonClient.live()
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
        usesLocalConductor = ConductorDatabase().exists
        broker = Broker(adapters: ConductorSources.adapters(client: client), cache: cache, draftStore: draftStore)
        let d = UserDefaults.standard
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
            MainActor.assumeIsolated { HotKeyCenter.shared.recheck() }
        }
        Notifier.shared.onOpen = { open in QuickComposerController.shared.show(notification: open) }
        // An update notification opens Settings > About: it names no chat, so the composer never hears of it.
        Notifier.shared.onOpenUpdate = { [weak self] in self?.openSettings(.about) }
        updater.onChange = { [weak self] in self?.updateStateChanged() }
        if demoMode, let v = ProcessInfo.processInfo.environment["SQUEAK_MAC_DEMO_UPDATE"], !v.isEmpty {
            updater.demoFound(v, notes: ["The menu-bar mark shows a dot when an update is waiting."])
        }
        observeWindowVisibility()
        AppLog.info("started version \(Self.appVersion), local Conductor reader \(usesLocalConductor ? "on" : "off")")
        if demoMode { installDemo(); return }
        updater.start(enabled: !captureMode)
        daemon.reconcileAtLaunch()
        Task { [weak self] in
            guard let self else { return }
            await broker.restoreFromCache()
            if let cache { knownMessages = (try? await cache.allMessages()) ?? [:] }
            await broker.setMode(.background)
            await broker.start()
            await startDatabaseWatcher()
            await restoreAfterUpdate()
        }
        Task { [weak self] in
            guard let self else { return }
            for await event in broker.events { await handle(event) }
        }
        Task { [weak self] in
            while !Task.isCancelled {
                self?.tokenPresent = self?.client.hasToken ?? true
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func handle(_ event: BrokerEvent) async {
        switch event {
        case .catalogChanged:
            sessions = await broker.sessions()
            hasLoaded = true
            if let selected, openURL == nil { openURL = await broker.openInHostURL(for: selected) }
            await refreshNeedsYouText()
            await refreshAsks()
        case .messagesChanged(let key):
            let all = await broker.messages(for: key)
            knownMessages[key] = all
            if key == selected {
                messages = all
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
                sessions = await broker.sessions()
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
            guard notificationsEnabled, !displayed else { return }
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
    private func markSelectedDisplayed() {
        guard let key = selected, let loaded = selectedLoadedAt, unread.hasUnread(key), conversationOnScreen else { return }
        unread.markRead(key, through: loaded)
        saveUnread()
    }

    /// Fills the model from DemoData and stops there: no broker, no polling, no network.
    func installDemo() {
        let d = DemoData.make()
        sessions = d.sessions
        needsYouText = d.needsYouText
        asks = d.asks
        health = AdapterHealth(adapterId: "demo", status: .connected, lastSyncedAt: Date())
        adapterHealths = [
            "conductor-local": AdapterHealth(adapterId: "conductor-local", status: .connected, lastSyncedAt: Date()),
            "conductor-daemon": AdapterHealth(adapterId: "conductor-daemon", status: .connected, lastSyncedAt: Date()),
        ]
        tokenPresent = true
        hasLoaded = true
        firstConnectionSeen = true
        usage = DemoData.usage()
        Task { await refreshLiveSteps() }
    }

    // MARK: Window visibility drives the poll mode

    private func observeWindowVisibility() {
        let nc = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.willCloseNotification,
            NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
        ]
        for name in names {
            visibilityTokens.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.recomputeVisibility() }
            })
        }
    }

    /// Read-only file-system events on conductor.db and its WAL; the timers keep running as the fallback.
    private func startDatabaseWatcher() {
        guard usesLocalConductor, databaseWatcher == nil else { return }
        let path = ConductorDatabase.defaultPath
        let broker = self.broker
        let watcher = FileChangeWatcher(paths: [path, path + "-wal"]) {
            Task { await broker.nudge() }
        }
        watcher.start()
        databaseWatcher = watcher
    }

    func recomputeVisibility() {
        let visible = captureMode || NSApp.windows.contains { w in
            w.isVisible && w.canBecomeKey && !w.isMiniaturized && w.occlusionState.contains(.visible)
        }
        guard visible != windowVisible else { return }
        windowVisible = visible
        Task { await broker.setMode(visible ? .foreground : .background) }
        if visible { markSelectedDisplayed() }
    }

    /// The source answered on the last poll, so a transcript read just now is current.
    private var transcriptIsLive: Bool {
        isConnected || adapterHealths["conductor-local"]?.status == .connected
    }

    // MARK: Derived

    var effectiveStatus: ConnectionStatus {
        guard let h = health else { return .degraded("Connecting") }
        if h.status == .connected, !tokenPresent { return .tokenMissing }
        return h.status
    }

    var isConnected: Bool { effectiveStatus == .connected }

    var visibleSessions: [HostSession] {
        let now = Date()
        return sessions.filter { s in
            switch filter {
            case .all: break
            case .provider(let p): if s.key.provider != p { return false }
            case .repo(let r): if s.repoName != r { return false }
            }
            switch navFilter ?? .all {
            case .all: return true
            case .needsYou: return SessionGrouping.kind(of: s, now: now) == .needsYou
            case .working: return SessionGrouping.kind(of: s, now: now) == .working
            case .done: return SessionGrouping.kind(of: s, now: now) == .done
            case .source(let src): return s.source == src
            case .usage: return true
            }
        }
    }

    /// Sessions in a sidebar filter, whatever filter is selected now (for the counts).
    func count(_ f: NavFilter) -> Int {
        let now = Date()
        switch f {
        case .all: return sessions.filter { !SessionGrouping.isEarlier($0, now: now) }.count
        case .needsYou: return sessions.filter { SessionGrouping.kind(of: $0, now: now) == .needsYou }.count
        case .working: return sessions.filter { SessionGrouping.kind(of: $0, now: now) == .working }.count
        case .done: return sessions.filter { SessionGrouping.kind(of: $0, now: now) == .done }.count
        case .source(let src): return sessions.filter { $0.source == src }.count
        case .usage: return 0
        }
    }

    /// "8 sessions · 3 working": every session not idle for more than a day, and how many of them are mid-turn.
    var sessionsSummary: String {
        let all = count(.all), working = count(.working)
        let base = "\(all) session\(all == 1 ? "" : "s")"
        return working > 0 ? "\(base) · \(working) working" : base
    }
    var hasCodexApp: Bool { sessions.contains { $0.source == .codexApp } }

    func liveStep(_ key: SessionKey) -> String? { liveSteps[key] }

    @ObservationIgnored private var liveStepsAt = Date.distantPast
    @ObservationIgnored private var liveStepsRefreshing = false

    /// The newest step of each working session in the list (at most 8) as one short phrase each, read
    /// from the same activity feed as the detail. Cheap by construction: only working sessions that
    /// are listed, at most one pass every 4s however many views ask, and a failed read keeps the last
    /// phrase. A session with no steps yet gets no phrase, so its row says "working", never a guess.
    func refreshLiveSteps(force: Bool = false) async {
        guard force || Date().timeIntervalSince(liveStepsAt) >= 4, !liveStepsRefreshing else { return }
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
        if out != liveSteps { liveSteps = out }
    }

    /// Polls about every 5s for as long as the calling view is on screen.
    func pollLiveSteps() async {
        while !Task.isCancelled {
            await refreshLiveSteps()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    /// Real data only. Squeak's adapters expose no diff or test results, so live sessions have none.
    func summaryLine(for s: HostSession) -> String? { demoMode ? DemoData.summary(for: s.key) : nil }

    /// §8.2 sections: needs you, done, working, error, idle; pinned first inside each.
    var grouped: [SessionSection] { SessionGrouping.group(visibleSessions, pinned: pinned) }

    /// The agent's latest message for a session: the open transcript, else the cached card text.
    func lastAgentText(_ key: SessionKey) -> String? {
        knownMessages[key]?.last(where: { $0.role == .assistant })?.text ?? needsYouText[key]
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

    /// Reads the question card's data for blocked Conductor chats, once per change of the chat.
    private func refreshAsks() async {
        guard !demoMode, !captureMode else { return }
        let blocked = sessions.filter { $0.state == .blocked && $0.alive != false && $0.key.provider == "conductor" }
        askFetchedAt = askFetchedAt.filter { k, _ in blocked.contains { $0.key == k } }
        for s in blocked where askFetchedAt[s.key] != .some(s.lastActivityAt) {
            askFetchedAt[s.key] = .some(s.lastActivityAt)
            guard let target = s.replyTarget else { continue }
            if let found = try? await client.pendingAsk(conductorSessionId: target) { asks[s.key] = found } else { asks[s.key] = nil }
        }
        asks = asks.filter { k, _ in blocked.contains { $0.key == k } }
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

    var ordered: OrderedSessions { SessionOrdering.order(visibleSessions, pinned: pinned) }
    var providers: [String] { Array(Set(sessions.map(\.key.provider))).sorted() }
    var repos: [String] { Array(Set(sessions.compactMap(\.repoName))).sorted() }

    var searchHits: [SearchHit] {
        SearchIndex(sessions: sessions, messages: knownMessages).search(query)
    }

    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    func session(_ key: SessionKey?) -> HostSession? {
        guard let key else { return nil }
        return sessions.first { $0.key == key }
    }

    var selectedSession: HostSession? { session(selected) }
    var attentionCount: Int { sessions.filter { $0.state == .blocked && $0.alive != false }.count }

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
        if key != nil, navFilter == .usage { navFilter = .all }
        // Opening a chat from anywhere (a notification, ⌘1…9) leaves Settings.
        if key != nil { closeSettings() }
        guard key != selected else { return }
        if let old = selected { saveDraftNow(draft, for: old) }
        selected = key
        selectedLoadedAt = nil
        activity = []
        openURL = nil
        draft = ""
        messages = key.map { knownMessages[$0] ?? [] } ?? []
        paging = EarlierPaging()
        if demoMode {
            if let key { messages = DemoData.transcript(for: key); activity = DemoData.activity(for: key) }
            return
        }
        Task { [weak self] in
            guard let self else { return }
            guard let key else { await broker.setFocused(nil); return }
            await broker.setFocused(key)
            self.openURL = await broker.openInHostURL(for: key)
            self.draft = await broker.draft(for: key) ?? ""
            self.messages = await broker.messages(for: key)
            let started = Date()
            await broker.refreshTranscript()
            if self.selected == key { self.paging = await broker.paging(for: key) }
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

    func refreshActivity() async {
        guard let key = selected, !demoMode else { return }
        let steps = (try? await broker.activity(for: key)) ?? []
        if key == selected, steps != activity { activity = steps }
    }

    func recheck() { Task { await broker.refresh() } }

    // MARK: Awake

    /// The Mac's awake session as the daemon last said; nil when none runs.
    private(set) var awake: DaemonAwake?
    private(set) var awakeOffered = false
    /// Lid-closed sessions are set up (the sudoers rule is in).
    private(set) var awakeLidReady = false
    private(set) var settingUpLid = false
    private(set) var settingUpFans = false
    private(set) var settingUpPower = false
    /// The Mac's energy mode, and whether its rule is in; nil from an older daemon or a Mac with none.
    private(set) var power: DaemonPower?
    private(set) var heat: DaemonHeat?
    private(set) var hotspot: DaemonHotspot?
    /// What a closed lid does (nil from a daemon that does not say), and the rest of the daemon's awake report.
    private(set) var awakeLidActions: DaemonLidActions?
    /// What a session does with the lid open; nil from a daemon without the two modes.
    private(set) var awakeOpenActions: DaemonOpenActions?
    private(set) var awakeLidClosedNow = false
    private(set) var awakeLastEnd: DaemonAwakeEnd?
    private(set) var awakeSleepProblem: String?
    /// The daemon's effective safety floors; nil from an older daemon (the views then say 40 and 10).
    private(set) var awakeRules: DaemonAwakeRules?
    /// Why the last hotspot save or removal did not happen, and whether one is in flight.
    private(set) var hotspotNote: String?
    private(set) var savingHotspot = false
    /// Why the last change to it did not happen, in plain words.
    private(set) var awakeNote: String?

    /// Reads the awake session (and the hotspot) for the menu bar, every 20 seconds for as long as
    /// the app runs: the countdown beside the duck must not wait for the popover to open.
    func pollAwake() async {
        while !Task.isCancelled {
            await readAwake()
            try? await Task.sleep(for: .seconds(20))
        }
    }

    func readAwake() async {
        if demoMode { awakeOffered = true; return }
        guard let state = try? await client.state() else { return }
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
    private(set) var usage: UsageSnapshot?
    private(set) var claudeRefreshing = false
    /// Why the last Refresh did not produce a new reading, in plain words; nil otherwise.
    private(set) var claudeRefreshNote: String?
    @ObservationIgnored private var claudeRefreshedAt: Date?

    func readUsage() async {
        if demoMode { usage = DemoData.usage(); return }
        guard let state = try? await client.state() else { return }
        let next = state.usage()
        if next != usage { usage = next }
    }

    /// Re-reads while a usage view is on screen. Codex's reading is live; Claude's changes only
    /// when Refresh is pressed (or Squeak's own chat asks a question).
    func pollUsage() async {
        while !Task.isCancelled {
            await readUsage()
            try? await Task.sleep(for: .seconds(15))
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
    func send(_ text: String, to key: SessionKey, mode: SendMode = .queue, answering: Bool = false) async -> SendResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if demoMode { return .notSent(reason: "Demo data: nothing is sent.") }
        lastUsed = key
        defaults.set(key.stringValue, forKey: "lastUsed")
        if key == selected { draftTask?.cancel(); draft = "" }
        let turn = answering ? await broker.currentTurnId(for: key) : nil
        let result = await broker.send(trimmed, to: key, mode: mode, answersTurn: turn)
        switch result {
        case .accepted(let via, let delivery, _): AppLog.info("send accepted via \(via), \(delivery?.rawValue ?? "sent")")
        case .refused: AppLog.info("send refused")
        case .uncertain: AppLog.info("send uncertain")
        case .notSent: AppLog.info("send not sent")
        }
        // Nothing left our hands: the words go back to the draft so they are never lost.
        switch result {
        case .refused, .notSent:
            if key == selected, draft.isEmpty { setDraft(text) }
        default: break
        }
        return result
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
        ActivationPolicyController.shared.willShowWindow()
        // Create the window only once Squeak is a regular app: a window made while it is still a
        // menu-bar accessory is treated like a panel and can land on top of a full-screen app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.openConversationWindow?() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.recomputeVisibility() }
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
    /// The page the next visit starts on, so reopening Settings lands where it was left.
    @ObservationIgnored private var lastSettingsSection: SettingsSection = .general

    /// Opens the main window on a Settings page (⌘, , the menu-bar panel, the sidebar's Settings row).
    func openSettings(_ section: SettingsSection? = nil) {
        settingsSection = section ?? lastSettingsSection
        showConversationWindow()
    }

    /// Switches the page without opening a window (captures, which host the window themselves).
    func openSettingsInPlace(_ section: SettingsSection) { settingsSection = section }

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

    /// Written as the app quits for an update: what is open, so the next launch can put it back.
    /// The open chat's draft is saved with it (drafts live in the cache, not in the marker).
    func saveUpdateRestore() {
        guard !demoMode, !captureMode else { return }
        if let selected { saveDraftNow(draft, for: selected) }
        let window: UpdateRestoreMarker.Window
        if settingsSection != nil { window = .settings }
        else if NSApp.windows.contains(where: { ActivationPolicyController.isAppWindow($0) && $0.title == "Squeak" }) { window = .conversation }
        else if OnboardingController.shared.isShowing { window = .welcome }
        else { window = .none }
        let marker = UpdateRestoreMarker(
            fromVersion: Self.appVersion, window: window, session: selected?.stringValue,
            settingsSection: settingsSection?.rawValue)
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
            databaseExists: ConductorDatabase().exists,
            localHealth: adapterHealths["conductor-local"],
            daemonHealth: adapterHealths["conductor-daemon"],
            tokenPresent: tokenPresent)
    }

    func diagnosticsText() -> String {
        let names = ["conductor-local": "Conductor database", "conductor-daemon": "Squeak service"]
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
            logLines: AppLog.buffer.last(50)))
    }

    func copyDiagnostics() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(diagnosticsText(), forType: .string)
        AppLog.info("diagnostics copied")
    }

    // MARK: Connection wording

    /// Conductor chats are read straight from its database, so a stopped daemon
    /// costs sending and terminal sessions, not the chat list.
    private var readingDirectly: Bool {
        usesLocalConductor && adapterHealths["conductor-local"]?.status == .connected && effectiveStatusIsDaemonDown
    }
    private var effectiveStatusIsDaemonDown: Bool { adapterHealths["conductor-daemon"]?.status == .daemonDown }

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
            "Conductor chats are read directly, so they stay up to date. Replying and terminal sessions need Squeak's background service, which isn't running. Start it with “launchctl kickstart -k gui/$(id -u)/com.squeak.daemon” in Terminal."
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
