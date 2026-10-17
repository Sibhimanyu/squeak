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

    // MARK: Selection and conversation
    private(set) var selected: SessionKey?
    private(set) var messages: [ChatMessage] = []
    private(set) var activity: [ActivityStep] = []
    private(set) var openURL: URL?
    private(set) var draft = ""
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
        broker = Broker(adapters: [ConductorDaemonAdapter(client: client)], cache: cache, draftStore: draftStore)
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
        case .messagesChanged(let key):
            let all = await broker.messages(for: key)
            knownMessages[key] = all
            if key == selected { messages = all }
        case .connection(let h):
            health = h
            if h.status == .connected {
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
        return await broker.send(trimmed, to: key)
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

    // MARK: Connection wording

    var connectionTitle: String {
        switch effectiveStatus {
        case .connected: "Connected"
        case .daemonDown: "Squeak service is off"
        case .tokenMissing: "Access token missing"
        case .degraded(let r): hasLoaded || health != nil ? "Trouble connecting" : r
        }
    }

    var connectionHelp: String? {
        switch effectiveStatus {
        case .connected: nil
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
