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
    @ObservationIgnored var openConversationWindow: (() -> Void)?
    @ObservationIgnored var openSettingsWindow: (() -> Void)?
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
    private(set) var activity: [ActivityStep] = []
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
    var hotKeyID: String? { didSet { defaults.set(hotKeyID, forKey: "hotKey"); HotKeyCenter.shared.register(HotKeyPreset.preset(id: hotKeyID)) } }
    var notificationsEnabled: Bool { didSet { defaults.set(notificationsEnabled, forKey: "notifications") } }
    var notificationsShowNames: Bool { didSet { defaults.set(notificationsShowNames, forKey: "notificationNames") } }
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
        usesLocalConductor = ConductorDatabase().exists
        broker = Broker(adapters: ConductorSources.adapters(client: client), cache: cache, draftStore: draftStore)
        let d = UserDefaults.standard
        pinned = Set((d.stringArray(forKey: "pinned") ?? []).compactMap(SessionKey.init(stringValue:)))
        hotKeyID = d.string(forKey: "hotKey")
        notificationsEnabled = d.object(forKey: "notifications") as? Bool ?? true
        notificationsShowNames = d.bool(forKey: "notificationNames")
        onboardingDone = d.bool(forKey: "onboardingDone")
        lastUsed = d.string(forKey: "lastUsed").flatMap(SessionKey.init(stringValue:))
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
        HotKeyCenter.shared.onFire = { QuickComposerController.shared.toggle() }
        if !captureMode { HotKeyCenter.shared.register(HotKeyPreset.preset(id: hotKeyID)) }
        Notifier.shared.onOpen = { [weak self] key in
            self?.select(key)
            self?.showConversationWindow()
        }
        observeWindowVisibility()
        AppLog.info("started version \(Self.appVersion), local Conductor reader \(usesLocalConductor ? "on" : "off")")
        if demoMode { installDemo(); return }
        updater.start(enabled: !captureMode)
        Task { [weak self] in
            guard let self else { return }
            await broker.restoreFromCache()
            if let cache { knownMessages = (try? await cache.allMessages()) ?? [:] }
            await broker.setMode(.background)
            await broker.start()
            await startDatabaseWatcher()
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
            if key == selected { messages = all }
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
            guard notificationsEnabled, !captureMode else { return }
            if windowVisible, n.key == selected { return }
            Notifier.shared.post(n, showName: notificationsShowNames)
        }
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

    /// "8 active across your Mac": everything except idle for more than a day.
    var activeCount: Int { count(.all) }
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
        if case .unsupported = s.capabilities.send { return false }
        return s.replyTarget != nil
    }

    var sendableSessions: [HostSession] { ordered.flattened.filter(canSend) }

    // MARK: Selection

    func select(_ key: SessionKey?) {
        if key != nil, navFilter == .usage { navFilter = .all }
        guard key != selected else { return }
        if let old = selected { saveDraftNow(draft, for: old) }
        selected = key
        activity = []
        openURL = nil
        draft = ""
        messages = key.map { knownMessages[$0] ?? [] } ?? []
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
            await broker.refreshTranscript()
        }
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

    /// Takes one fresh Claude reading. Only ever called from the user pressing Refresh: it makes a
    /// real, tiny Claude call, so it never runs on a timer.
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
            if result.throttled {
                claudeRefreshNote = "Just refreshed. Squeak asks Claude at most once a minute."
            } else if !result.refreshed {
                claudeRefreshNote = result.error ?? "Claude did not report its limits this time."
            }
        } catch AdapterError.timedOut {
            claudeRefreshNote = "Claude took too long to answer."
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

    func send(_ text: String, to key: SessionKey, mode: SendMode = .queue) async -> SendResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if demoMode { return .notSent(reason: "Demo data: nothing is sent.") }
        lastUsed = key
        defaults.set(key.stringValue, forKey: "lastUsed")
        if key == selected { draftTask?.cancel(); draft = "" }
        let result = await broker.send(trimmed, to: key, mode: mode)
        switch result {
        case .accepted(let via, let delivery, _): AppLog.info("send accepted via \(via), \(delivery?.rawValue ?? "sent")")
        case .refused: AppLog.info("send refused")
        case .uncertain: AppLog.info("send uncertain")
        case .notSent: AppLog.info("send not sent")
        }
        return result
    }

    /// Puts a refused or unsent message back in the composer. Never sends.
    func reuse(_ message: ChatMessage) {
        guard selected != nil else { return }
        setDraft(message.text)
    }

    // MARK: Pins, windows

    func togglePin(_ key: SessionKey) {
        if pinned.contains(key) { pinned.remove(key) } else { pinned.insert(key) }
        defaults.set(pinned.map(\.stringValue).sorted(), forKey: "pinned")
    }

    func showConversationWindow() {
        ActivationPolicyController.shared.willShowWindow()
        // Create the window only once Squeak is a regular app: a window made while it is still a
        // menu-bar accessory is treated like a panel and can land on top of a full-screen app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.openConversationWindow?() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.recomputeVisibility() }
    }

    func open(_ key: SessionKey) {
        select(key)
        showConversationWindow()
    }

    func openInHost() {
        if let openURL { NSWorkspace.shared.open(openURL) }
    }

    func openSettings() {
        ActivationPolicyController.shared.willShowWindow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.openSettingsWindow?() }
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
            knownMessages = [:]
            cacheNotice = "Cache deleted. Squeak will rebuild it as you open conversations."
        } catch {
            cacheNotice = "Couldn't delete the cache: \(error.localizedDescription)"
        }
    }

    // MARK: Updates

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
