import AppKit
import Observation
import SqueakMacCore
import SwiftUI

enum SessionFilter: Hashable {
    case all
    case provider(String)
    case repo(String)
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

    // MARK: Updates (a notice only; nothing is downloaded or installed)
    private(set) var availableUpdate: AvailableUpdate?
    private(set) var lastUpdateCheck: Date?
    var updateChecksEnabled: Bool {
        didSet {
            defaults.set(updateChecksEnabled, forKey: "updateChecks")
            if updateChecksEnabled { startUpdateChecks() } else { updateTask?.cancel(); updateTask = nil; availableUpdate = nil }
        }
    }
    @ObservationIgnored private var updateTask: Task<Void, Never>?

    // MARK: Selection and conversation
    private(set) var selected: SessionKey?
    private(set) var messages: [ChatMessage] = []
    private(set) var activity: [ActivityStep] = []
    private(set) var openURL: URL?
    private(set) var draft = ""
    /// The agent's last message for sessions that need you, so cards can show the question and options.
    private(set) var needsYouText: [SessionKey: String] = [:]
    @ObservationIgnored private var needsYouFetchedAt: [SessionKey: Date?] = [:]
    @ObservationIgnored private var knownMessages: [SessionKey: [ChatMessage]] = [:]
    @ObservationIgnored private var draftTask: Task<Void, Never>?

    // MARK: Browsing
    var query = ""
    var filter: SessionFilter = .all
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

    init() {
        let env = ProcessInfo.processInfo.environment
        captureMode = env["SQUEAK_MAC_CAPTURE"] != nil
        client = DaemonClient.live()
        // The capture run never touches the real Keychain or the real cache file.
        if captureMode {
            cache = nil
        } else {
            cache = EncryptedCache(keyStore: KeychainKeyStore())
        }
        let draftStore = cache.map { DraftStore(cache: $0) }
        usesLocalConductor = ConductorDatabase().exists
        broker = Broker(adapters: ConductorSources.adapters(client: client), cache: cache, draftStore: draftStore)
        updateChecksEnabled = UserDefaults.standard.object(forKey: "updateChecks") as? Bool ?? true
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
        startUpdateChecks()
        Task { [weak self] in
            guard let self else { return }
            await broker.restoreFromCache()
            if let cache { knownMessages = (try? await cache.allMessages()) ?? [:] }
            await broker.setMode(.background)
            await broker.start()
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
        sessions.filter { s in
            switch filter {
            case .all: true
            case .provider(let p): s.key.provider == p
            case .repo(let r): s.repoName == r
            }
        }
    }

    /// The brief's sections (Needs you / Working / Recent / Earlier), pinned first inside each.
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
        SearchIndex(sessions: visibleSessions, messages: knownMessages).search(query)
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
        guard key != selected else { return }
        if let old = selected { saveDraftNow(draft, for: old) }
        selected = key
        activity = []
        openURL = nil
        draft = ""
        messages = key.map { knownMessages[$0] ?? [] } ?? []
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
        guard let key = selected else { return }
        let steps = (try? await broker.activity(for: key)) ?? []
        if key == selected, steps != activity { activity = steps }
    }

    func recheck() { Task { await broker.refresh() } }

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

    func send(_ text: String, to key: SessionKey) async -> SendResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        lastUsed = key
        defaults.set(key.stringValue, forKey: "lastUsed")
        if key == selected { draftTask?.cancel(); draft = "" }
        let result = await broker.send(trimmed, to: key)
        switch result {
        case .accepted(let via): AppLog.info("send accepted via \(via)")
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
        NSApp.activate()
        openConversationWindow?()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.recomputeVisibility() }
    }

    func open(_ key: SessionKey) {
        select(key)
        showConversationWindow()
    }

    func openInHost() {
        if let openURL { NSWorkspace.shared.open(openURL) }
    }

    func openSettings() {
        NSApp.activate()
        openSettingsWindow?()
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

    /// On launch and every 24 hours. Never in a capture run.
    private func startUpdateChecks() {
        guard updateChecksEnabled, !captureMode, updateTask == nil else { return }
        updateTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkForUpdate()
                try? await Task.sleep(for: .seconds(24 * 3600))
            }
        }
    }

    private func checkForUpdate() async {
        let result = await UpdateChecker().check(currentVersion: Self.appVersion)
        lastUpdateCheck = Date()
        switch result {
        case .available(let u):
            AppLog.info("update check: \(u.version) available")
            availableUpdate = u.tag == defaults.string(forKey: "dismissedUpdate") ? nil : u
        case .upToDate:
            AppLog.info("update check: up to date")
            availableUpdate = nil
        case .failed(let why):
            AppLog.info("update check failed: \(why)")
        }
    }

    func viewRelease() {
        if let url = availableUpdate?.releaseURL { NSWorkspace.shared.open(url) }
    }

    func dismissUpdate() {
        if let u = availableUpdate { defaults.set(u.tag, forKey: "dismissedUpdate") }
        availableUpdate = nil
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
            lastUpdateCheck: lastUpdateCheck,
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
