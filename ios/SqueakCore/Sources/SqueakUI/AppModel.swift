#if os(iOS)
import Foundation
import LocalAuthentication
import Network
import SqueakCore
import SwiftUI
import UIKit

/// The whole app's state. It decides nothing about agents — the Mac does
/// (DESIGN.md §1, "every surface agrees") — it only fetches, shows and sends.
///
/// Observable per property: a view redraws only when something it read changes. As one
/// ObservableObject, every streamed step redrew the list under the chat, the whole chat and
/// the field being typed in, which is what made the phone lag while an agent worked.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case unpaired
        /// Waiting for the Mac to approve; both screens show `code`.
        case awaitingApproval(code: String, mac: String)
        case paired
    }

    private(set) var phase: Phase = .unpaired
    private(set) var snapshot: PhoneSnapshot? {
        didSet {
            remember(snapshot); settleStarting(snapshot); settleFilmChat()
            // Set from outside `publish` (demo, an optimistic edit, a saved view, sign-out): the slices follow now.
            if !publishing { resyncSlices() }
        }
    }
    /// What Home draws; set only when it differs, so Home does not redraw for usage, presence or another chat's detail.
    private(set) var home = HomeSlice.empty { didSet { homeVersion += 1 } }
    /// The chats, one observable box each: a chat's screen reads only its own.
    @ObservationIgnored let sessionStore = SessionStore()
    private(set) var macControls: PhoneSnapshot.MacControls?
    private(set) var workSteps: Bool?
    @ObservationIgnored private var homeVersion = 0
    @ObservationIgnored private var publishing = false
    @ObservationIgnored private var publishedSlices = SnapshotSlices.empty
    @ObservationIgnored private var rebuildGeneration = 0
    @ObservationIgnored private var listMemo: (version: Int, hidden: [String: Double], seen: [String: Double], lists: HomeLists)?
    /// A chat the Mac accepted, until it shows up in the snapshot (the row's "Starting…").
    private(set) var startingChat: StartingChat?

    struct StartingChat: Equatable { let sessionId: String; let label: String }
    enum StartResult: Equatable { case started, cancelled, refused(String) }
    /// When this phone last heard from the server: a stream event (keep-alives
    /// included) or a full read. Never a presence write: that one only proves
    /// the server took a write, not that the view on screen is current.
    private(set) var lastFetch: Date?
    /// Since when the view's stream has been down, nil while it is up.
    private(set) var streamDownSince: Date?
    /// Which way this phone is talking to the Mac: the direct same-Wi-Fi path or the cloud.
    private(set) var route: ChannelRoute = .cloud
    @ObservationIgnored private var routeTask: Task<Void, Never>?
    /// When the Mac last answered a presence ping (its clock), nil from a Mac that never does.
    private(set) var macAliveAt: Date?
    /// When the app last came on screen: the answer on record then is from the visit before.
    private(set) var lookingSince: Date?
    private(set) var problem: String?
    /// Why the last pairing did not happen, for the unpaired screen (`PairingScreen`).
    private(set) var pairingFailure: PairingFailure?
    /// When the current pairing asked the Mac, for the wait limit.
    private(set) var pairingAskedAt: Date?
    /// The Mac's name from approval until the celebration has shown.
    private(set) var pairingCelebration: String?
    /// The Squeak account: sign-in, Your Macs, adding one without a QR code.
    @ObservationIgnored let account = AccountModel()
    func endPairingCelebration() { pairingCelebration = nil }
    func clearPairingFailure() { pairingFailure = nil; problem = nil }
    /// What this phone sent since the app opened, per session. Local only:
    /// the channel carries no conversation history back, so the phone shows
    /// its own replies and the Mac's latest message, nothing it cannot know.
    private(set) var outbox: [String: [SentMessage]] = [:]

    typealias SentMessage = ChatSend

    /// The last agent message seen per session, so a working turn keeps the previous answer on screen.
    private(set) var remembered: [String: RememberedMessage] = [:]

    /// "Show thinking live" (Settings): the open session's whole turn, as it
    /// happens, instead of its newest six steps. Off by default; the Mac
    /// sends it only while this phone has that session open.
    /// On unless switched off in Settings: the open chat's turn, live, is what a working chat shows.
    var verbose: Bool = UserDefaults.standard.object(forKey: "squeak.verbose") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(verbose, forKey: "squeak.verbose")
            restartLive()
        }
    }
    /// The verbose view per session key, while it is being watched.
    private(set) var liveTurns: [String: LiveTurn] = [:]
    /// The newest history each chat had when last open, also kept on the phone (`HistoryStore`: Caches, complete
    /// file protection, no backup, 30 chats, gone on unpair). A chat opened again, even after a relaunch, shows it
    /// in its first frame, so the history arriving a moment later does not push everything down.
    private(set) var lastHistory: [String: [LiveTurn.HistoryEntry]] = [:]
    /// The same per chat with where its older pages go on (`ChatHistoryState`): the live push of the newest eight
    /// merges over the tail, pages asked for land in front. `lastHistory` is always its `entries`.
    @ObservationIgnored private var historyStates: [String: ChatHistoryState] = [:]
    /// This phone's clock against the Mac's, read off the results the Mac stamps. The chat compares the two.
    private(set) var clockSkew = ClockSkew()
    /// Chats whose missing middle (a hole in the history after a reconnect) is being fetched.
    private(set) var catchingUp: Set<String> = []
    /// Where each chat's request for earlier messages stands. One at a time per chat.
    private(set) var earlierLoad: [String: EarlierPaging.Load] = [:]
    /// When older messages last landed above a chat's first one: the chat keeps the reader's place.
    private(set) var earlierPrependedAt: [String: Date] = [:]
    /// The last timeline each chat drew, in memory, so reopening a chat shows it in its first frame (`ChatTimelineStore`).
    @ObservationIgnored private var timelineFrames = TimelineFrameCache()
    /// Nil in the demo, which must neither read nor write the real cache.
    @ObservationIgnored private let historyStore: HistoryStore?
    /// The Mac's last view, kept across launches (`SnapshotStore`) so a cold launch shows it at once. Nil in the demo.
    @ObservationIgnored private let snapshotStore: SnapshotStore?
    /// A view read from disk is on screen, and no fresh one has arrived yet: the list says it is updating.
    private var savedShown = false
    /// When the phone came back from a long absence; the view on screen is old until a fresh one lands after it.
    private var returnedAt: Date?
    var showingSaved: Bool {
        guard !demo else { return false }
        if savedShown && freshSnapshotAt == nil { return true }
        if let returnedAt { return (freshSnapshotAt ?? .distantPast) < returnedAt }
        return false
    }
    /// There is a view to draw (a saved or an earlier one), so nothing needs to hide behind a splash.
    var hasView: Bool { home.present }
    /// Back after a long absence: the old view stays and says it is updating.
    func returnedFromBackground() { returnedAt = Date() }

    /// Writes the saved view now, off the main actor, under a background-task assertion so a suspend cannot cut it
    /// short (the store otherwise coalesces writes up to 3 s apart).
    func flushSaved() {
        guard let snapshotStore else { return }
        let task = UIApplication.shared.beginBackgroundTask(withName: "squeak.snapshot")
        DispatchQueue.global(qos: .userInitiated).async {
            snapshotStore.flush()
            if task != .invalid { DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(task) } }
        }
    }
    /// Sends not settled yet, kept across relaunches (`OutboxStore`). Nil in the demo.
    @ObservationIgnored private let outboxStore: OutboxStore?
    /// Restored sends whose answer, if the Mac wrote one while the app was gone, has not been looked for yet.
    @ObservationIgnored private var unreconciled = true
    /// A failed message put back for editing, per chat; the chat's composer takes it and clears it.
    var restoredDraft: [String: String] = [:]
    /// False once it is known the Mac's channel cannot stream (Firestore), so verbose cannot work.
    private(set) var liveAvailable = true

    @ObservationIgnored private var channel: Channel?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var unlock = SendUnlock()
    var sendConfirmation = SendConfirmation(defaults: .standard)
    /// The session open on screen.
    @ObservationIgnored private var watching: String?
    @ObservationIgnored private var liveTask: Task<Void, Never>?
    @ObservationIgnored private var subagentTask: Task<Void, Never>?

    /// The subagent the phone is following in the open chat (`SubagentFeed`), what the Mac last said of it, and why
    /// it could not be followed. Read-only on the Mac; stopped on leaving the chat, closing the sheet, backgrounding.
    struct SubagentWatch: Equatable, Identifiable {
        var id: String { task.id }
        enum Phase: Equatable { case asking, following, refused(String) }
        let key: String
        let task: PhoneSnapshot.Session.BackgroundTask
        var phase: Phase = .asking
        var feed: SubagentFeed?
    }
    private(set) var subagent: SubagentWatch?
    /// Bumped by every view applied from the stream, so a slower full read
    /// that started before it cannot put an older view back on screen.
    @ObservationIgnored private var snapshotEpoch = 0
    /// The Mac's view as written, and the recent document a split one leaves out. `snapshot` is these
    /// merged, with the open chat's state from its live turn when that is newer (`rebuild`).
    @ObservationIgnored private var baseSnapshot: PhoneSnapshot?
    /// When a view last arrived from the Mac (stream or fetch) in this run: never the demo's, never anything
    /// read from disk. The launch splash waits for it.
    private(set) var freshSnapshotAt: Date?
    @ObservationIgnored private var recentDoc: PhoneRecent?
    @ObservationIgnored private var seenSessions = SeenSessions()
    /// Chats this phone has a stake in (opened, sent to, or watched working) and when each was last looked at,
    /// as seconds since 1970. A reply that lands after that is unread. Kept across launches.
    private(set) var replySeen: [String: Double] = UserDefaults.standard.dictionary(forKey: "squeak.replySeen") as? [String: Double] ?? [:] {
        didSet {
            if replySeen.count > 300 { replySeen = Dictionary(uniqueKeysWithValues: replySeen.sorted { $0.value > $1.value }.prefix(200).map { ($0.key, $0.value) }) }
            UserDefaults.standard.set(replySeen, forKey: "squeak.replySeen")
        }
    }
    @ObservationIgnored private var iconCache: [String: (length: Int, image: UIImage, fit: LogoFit)] = [:]
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    /// True while this iPhone has no usable network (NWPathMonitor unsatisfied). Outranks every other status.
    private(set) var phoneOffline = false
    @ObservationIgnored private var lastPath: (satisfied: Bool, interfaces: [NWInterface.InterfaceType])?
    /// How many recent chats Home has asked for; "Show more" adds 20, up to the Mac's 50.
    private(set) var recentWanted = 10
    /// Sent only once more is asked for, so a phone at the default writes the same presence as before.
    private var recentAsk: Int? { recentWanted > 10 ? recentWanted : nil }

    /// The call history is on screen: presence then names "calls", so the Mac writes `voice.calls` (large) for us.
    private(set) var callsOpen = false

    func setCallsOpen(_ open: Bool) {
        guard callsOpen != open else { return }
        callsOpen = open
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk
        Task {
            try? await channel.touchPresence(watching: watching, recent: recent, calls: open)
            lastPresence = Date()
            if open { await refresh() }
        }
    }

    /// Ask the Mac for 20 more recent chats; they arrive with the next view.
    func showMoreRecent() {
        guard recentWanted < 50 else { return }
        recentWanted = min(50, recentWanted + 20)
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk, calls = callsOpen
        Task { try? await channel.touchPresence(watching: watching, recent: recent, calls: calls) }
    }

    /// What presence tells the Mac to stream: only in verbose mode.
    private var presenceWatching: String? { verbose ? watching : nil }
    @ObservationIgnored private var lastPresence = Date.distantPast
    @ObservationIgnored private let signer: CommandSigner
    let demo: Bool

    init() {
        demo = ProcessInfo.processInfo.arguments.contains("-squeak-demo") || ProcessInfo.processInfo.arguments.contains("-squeak-demo-films")
        signer = demo ? SoftwareSigner() : KeyStore.signer()
        historyStore = demo ? nil : HistoryStore()
        snapshotStore = demo ? nil : SnapshotStore()
        if let historyStore {
            historyStates = historyStore.states()
            lastHistory = historyStates.mapValues(\.entries)
        }
        outboxStore = demo ? nil : OutboxStore()
        if let outboxStore { outbox = Self.restore(outboxStore.all()) }
        if demo {
            snapshot = DemoData.snapshot
            outbox = DemoData.outbox
            liveTurns = DemoData.liveTurns
            if ProcessInfo.processInfo.arguments.contains("-squeak-stream") { streamDemo() }
            for (k, v) in DemoData.remembered { remembered[k] = v }
            lastFetch = Date()
            phase = .paired
            return
        }
        if let data = KeyStore.load(account: "pairing"),
           let pairing = try? JSONDecoder().decode(PairingPayload.self, from: data),
           let deviceId = KeyStore.load(account: "device-id").flatMap({ String(data: $0, encoding: .utf8) }) {
            channel = Channel(pairing: pairing, deviceId: deviceId, local: LocalSupport.standard)
            phase = KeyStore.load(account: "approved") != nil ? .paired : .awaitingApproval(
                code: ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963), mac: pairing.n)
            if phase == .paired { loadSavedSnapshot() }
        }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let interfaces = path.availableInterfaces.map(\.type)
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Back online: the Mac's last answer is from before the gap, so give it the open grace again.
                if self.phoneOffline && satisfied { self.lookingSince = Date() }
                self.phoneOffline = !satisfied
                self.networkChanged(satisfied: satisfied, interfaces: interfaces)
            }
        }
        pathMonitor.start(queue: .main)
    }

    /// Shows the view the Mac last sent, read and decoded off the main actor, unless a fresh one got here first.
    /// It sets only what is drawn (`snapshot`), never the base the stream's ordering compares against, so the first
    /// real view always replaces it, even one from a Mac that restarted with its clock behind.
    private func loadSavedSnapshot() {
        guard let snapshotStore else { return }
        Task { [weak self] in
            let saved = await Task.detached(priority: .userInitiated) { snapshotStore.load() }.value
            guard let self, let saved, self.snapshot == nil, self.freshSnapshotAt == nil, self.phase == .paired else { return }
            self.snapshot = saved
            self.savedShown = true
        }
    }

    /// A new network (Wi-Fi to cellular, back online): the old connections
    /// are dead but would take their stall timeout to say so. Start again now.
    private func networkChanged(satisfied: Bool, interfaces: [NWInterface.InterfaceType]) {
        let previous = lastPath
        lastPath = (satisfied, interfaces)
        guard let previous, satisfied, !previous.satisfied || previous.interfaces != interfaces, loop != nil else { return }
        // What was reachable on the old network may not be on this one: look for the Mac again.
        if let channel { Task { await channel.networkChanged() } }
        reconnect()
    }

    private func reconnect() {
        loop?.cancel()
        loop = nil
        liveTask?.cancel()
        liveTask = nil
        startLoop()
    }

    /// Demo only: a step every 700 ms and a snapshot every 1.5 s, like a busy turn on the real channel.
    private func streamDemo() {
        Task { [weak self] in
            var n = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(700))
                guard let self, let turn = self.liveTurns["tg"] else { return }
                let step = DemoData.streamSteps[n % DemoData.streamSteps.count]
                self.liveTurns["tg"] = LiveTurn(key: turn.key, working: true, total: turn.total + 1,
                                                steps: Array((turn.steps + [step]).suffix(50)), queue: turn.queue)
                if n % 2 == 1, let current = self.snapshot {
                    self.snapshot = PhoneSnapshot(
                        v: current.v, mac: current.mac, generatedAt: ISO8601DateFormatter().string(from: Date()), duck: current.duck,
                        sessions: current.sessions, usage: current.usage, workspaces: current.workspaces, recent: current.recent,
                        keepAwake: current.keepAwake, awakeUntil: current.awakeUntil,
                        awakeLid: current.awakeLid, awakeLidProblem: current.awakeLidProblem, awakeLidReady: current.awakeLidReady,
                        awakeSafety: current.awakeSafety, macPower: current.macPower,
                        awakeLidActions: current.awakeLidActions, awakeRules: current.awakeRules,
                        awakeLastEnd: current.awakeLastEnd, awakeSleepProblem: current.awakeSleepProblem)
                }
                n += 1
            }
        }
    }

    /* ---------- pairing ---------- */

    func pair(with text: String) async {
        do {
            let pairing = try PairingPayload.parse(text)
            let deviceId = UUID().uuidString.lowercased()
            let channel = Channel(pairing: pairing, deviceId: deviceId, local: LocalSupport.standard)
            try await channel.requestPairing(name: UIDevice.current.name, signer: signer)
            KeyStore.save(try JSONEncoder().encode(pairing), account: "pairing")
            KeyStore.save(Data(deviceId.utf8), account: "device-id")
            self.channel = channel
            problem = nil
            pairingFailure = nil
            pairingAskedAt = Date()
            phase = .awaitingApproval(code: ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963), mac: pairing.n)
            resume()
        } catch is PairingPayload.Failure {
            problem = "That isn't a Squeak pairing code. Open Squeak on your Mac, choose iPhone, then Pair an iPhone."
            pairingFailure = .notACode
        } catch {
            problem = "Couldn't reach Squeak's server. Check the connection and scan again."
            pairingFailure = .unreachable
        }
    }

    /// This phone's signing key, which a Squeak account request names (the Mac registers it under the request id).
    var devicePublicKey: Data { signer.publicKeyX963 }

    /// The relay base a saved Catalyst pairing names, for finding the account's app.
    var pairedRelayURL: String? {
        KeyStore.load(account: "pairing").flatMap { try? JSONDecoder().decode(PairingPayload.self, from: $0) }?.cu
    }

    /// A Mac's answer to an account request: the pairing a QR code carries, already approved on the Mac, so what a
    /// scanned code stores (with the request id as the device id) and no approval to wait for.
    func adopt(_ pairing: PairingPayload, deviceId: String) {
        KeyStore.save(try! JSONEncoder().encode(pairing), account: "pairing")
        KeyStore.save(Data(deviceId.utf8), account: "device-id")
        KeyStore.save(Data("1".utf8), account: "approved")
        channel = Channel(pairing: pairing, deviceId: deviceId, local: LocalSupport.standard)
        problem = nil
        pairingFailure = nil
        pairingCelebration = pairing.n
        phase = .paired
        if let channel { startLocal(channel) }
        resume()
    }

    func unpair() {
        pairingFailure = nil
        pairingAskedAt = nil
        routeTask?.cancel()
        routeTask = nil
        if let channel { Task { await channel.stopLocal() } }
        route = .cloud
        KeyStore.wipe()
        KeyStore.delete(account: "approved")
        channel = nil
        snapshot = nil
        baseSnapshot = nil
        recentDoc = nil
        seenSessions.reset()
        macAliveAt = nil
        phase = .unpaired
        loop?.cancel()
        liveTask?.cancel()
        liveTask = nil
        liveTurns = [:]
        lastHistory = [:]
        timelineFrames = TimelineFrameCache()
        historyStates = [:]
        clockSkew = ClockSkew()
        catchingUp = []
        earlierLoad = [:]
        earlierPrependedAt = [:]
        historyStore?.clear()
        snapshotStore?.clear()
        savedShown = false
        outboxStore?.clear()
        SentPhotos.clear()
        outbox = [:]
        unreconciled = true
    }

    /* ---------- the loop: only while the app is on screen ---------- */

    func resume() {
        unlock.foregrounded()
        guard !demo, loop == nil, channel != nil else { return }
        lookingSince = Date()
        startLoop()
    }

    private func startLoop() {
        guard !demo, loop == nil, let channel else { return }
        if phase == .paired { startLocal(channel) }
        loop = Task { [weak self] in
            await self?.tick()
            self?.restartLive()
            // Supervised: if any stream ends, all of them start again, so the
            // view can never sit frozen behind a stream that quietly died.
            while !Task.isCancelled {
                guard let states = await channel.stateEvents(), let results = await channel.resultChanges() else {
                    // Firestore: look again every couple of seconds.
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(Self.pollSeconds))
                        await self?.tick()
                    }
                    return
                }
                // Realtime Database: a new view (or the Mac's answer) arrives
                // as it is written, carried in the event itself so it is
                // downloaded once. The slow tick only keeps presence fresh.
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { for await event in states { await self?.handle(event) } }
                    group.addTask { for await _ in results { await self?.tickIfAwaitingApproval() } }
                    group.addTask {
                        while !Task.isCancelled {
                            try? await Task.sleep(for: .seconds(Self.streamedTickSeconds))
                            await self?.keepAlive()
                        }
                    }
                    await group.next()
                    group.cancelAll()
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// Looks for the Mac on the same Wi-Fi (the first time asks for Local Network access) and follows which way it is reached.
    private func startLocal(_ channel: Channel) {
        routeTask?.cancel()
        routeTask = Task { [weak self] in
            await channel.startLocal()
            for await route in await channel.routeUpdates() { self?.route = route }
        }
    }

    /// The Mac's own list of where it listens, from its view: tried at once if the cloud is in use.
    private func learnLocal(from snapshot: PhoneSnapshot?) {
        guard let channel, let info = snapshot?.local else { return }
        Task { await channel.learnLocal(info) }
    }

    /// One event off the state stream.
    private func handle(_ event: StateEvent) async {
        switch event {
        case .connected, .heard:
            lastFetch = Date()
            streamDownSince = nil
        case .dropped:
            if streamDownSince == nil { streamDownSince = Date() }
        case .snapshot(let next):
            apply(next)
        case .recent(let recent):
            guard !PhoneSnapshot.isStale(recent?.seq, than: recentDoc?.seq) else { return }
            recentDoc = recent
            rebuild()
        case .alive(let alive):
            if let alive { heard(alive) }
        case .move(let move):
            await follow(move)
        case .needsRead:
            await tick()
        }
    }

    /// The Mac moved the channel to another cloud store: keep the new pairing (relay key included, in the Keychain with
    /// the channel secret), rebuild the channel on the new store and start again, which writes presence there.
    private func follow(_ move: CloudMove) async {
        guard !demo, let current = channel, let moved = current.pairing.applying(move),
              let data = try? JSONEncoder().encode(moved),
              let deviceId = KeyStore.load(account: "device-id").flatMap({ String(data: $0, encoding: .utf8) }) else { return }
        KeyStore.save(data, account: "pairing")
        loop?.cancel()
        loop = nil
        routeTask?.cancel()
        routeTask = nil
        await current.stopLocal()
        channel = Channel(pairing: moved, deviceId: deviceId, local: LocalSupport.standard)
        startLoop()
    }

    /// Settings › Connection details: each open stream, as the phone sees it.
    func connectionDetails() async -> [StreamHealth] {
        guard !demo, let channel else { return [] }
        return await channel.streamHealth()
    }

    /// How often the phone looks for a new view while it is on screen, when
    /// it has to poll. The Mac publishes within about a second of a change, so
    /// this is most of what a finish waits for on the phone.
    static let pollSeconds = 2
    /// When streamed: presence must reach the Mac inside its 60s window.
    static let streamedTickSeconds = Int(MacLiveness.pingEvery)

    func pause() {
        closeSubagent()
        unlock.backgrounded()
        loop?.cancel()
        loop = nil
        routeTask?.cancel()
        routeTask = nil
        if let channel { Task { await channel.stopLocal() } }
        streamDownSince = nil
        let wasStreaming = presenceWatching != nil
        liveTask?.cancel()
        liveTask = nil
        // Ask the Mac to stop (and delete) the live turn now rather than when presence lapses.
        if wasStreaming, let channel { Task { try? await channel.touchPresence(watching: nil, recent: recentAsk, calls: callsOpen) } }
    }

    /// The session on screen, or nil when none is. In verbose mode the Mac streams its turn.
    func watch(_ key: String?) {
        guard watching != key else { return }
        closeSubagent()
        // A turn kept from an earlier visit is out of date by the time the chat is opened again.
        if let previous = watching { liveTurns[previous] = nil }
        watching = key
        rebuild()
        restartLive()
    }

    /// Tell the Mac what this phone watches now, and follow that session's live turn.
    private func restartLive() {
        liveTask?.cancel()
        liveTask = nil
        guard !demo, loop != nil, let channel else { return }
        let key = presenceWatching, recent = recentAsk, calls = callsOpen
        liveTask = Task { [weak self] in
            try? await channel.touchPresence(watching: key, recent: recent, calls: calls)
            self?.lastPresence = Date()
            guard let key else { return }
            guard let turns = await channel.liveTurns(for: key) else {
                self?.liveAvailable = false
                return
            }
            self?.liveAvailable = true
            for await turn in turns {
                if Task.isCancelled { break }
                guard let self, !PhoneSnapshot.isStale(turn?.seq, than: self.liveTurns[key]?.seq) else { continue }
                if self.liveTurns[key] != turn {
                    self.liveTurns[key] = turn
                    if let history = turn?.history, !history.isEmpty {
                        var state = self.historyStates[key] ?? ChatHistoryState()
                        state.mergeLatest(history)
                        self.setHistory(state, for: key)
                        // The push did not reach back to what was held: fetch the messages in between.
                        if state.gap != nil, let session = self.session(key) { Task { await self.catchUp(session) } }
                    }
                    self.noteQueue(turn, for: key)
                    self.rebuild()
                }
            }
        }
    }

    func refresh() async {
        await tick()
    }

    /* ---------- a subagent's steps ---------- */

    /// Why a subagent's steps are not on offer, in words: nil when they are. `verbose` is the phone's own
    /// "Show thinking live"; `liveAvailable` false is a channel that cannot stream.
    func subagentUnavailable(_ session: PhoneSnapshot.Session) -> String? {
        if demo { return nil }
        if !verbose { return "Turn on \u{201C}Show thinking live\u{201D} in Settings to read a duckling's steps." }
        if !liveAvailable { return "This connection cannot stream a duckling's steps." }
        return nil
    }

    /// Ask the Mac to follow `task` of the chat on screen, and read what it writes. Read-only: no Face ID.
    func openSubagent(_ task: PhoneSnapshot.Session.BackgroundTask, in session: PhoneSnapshot.Session) {
        guard task.canOpenSteps else { return }
        subagentTask?.cancel()
        let key = session.key
        subagent = SubagentWatch(key: key, task: task)
        if let reason = subagentUnavailable(session) { subagent?.phase = .refused(reason); return }
        if demo {
            subagent?.phase = .following
            subagent?.feed = SubagentFeed(key: key, taskId: task.id, agentId: task.agentId, label: task.label, status: task.status,
                available: true, total: 3, steps: [
                    .init(kind: "thinking", text: "Looking for every caller before changing the signature."),
                    .init(kind: "tool", text: "Searched for splitMarkdown"),
                    .init(kind: "note", text: "Found four callers; two are in tests.")])
            return
        }
        guard let channel, watching == key else {
            subagent?.phase = .refused("Open the chat first.")
            return
        }
        let taskId = task.id
        subagentTask = Task { [weak self] in
            do {
                let signer = self?.signer
                guard let signer else { return }
                let (id, document) = try await Task.detached(priority: .userInitiated) {
                    try channel.subagentDocument(key: key, taskId: taskId, signer: signer)
                }.value
                // Start reading before asking, so the first write is not missed.
                let feeds = await channel.subagentFeeds(for: key)
                try await channel.send(document, id: id)
                guard let self, let result = try await self.awaitResult(id, on: channel), !Task.isCancelled else {
                    self?.settleSubagent(taskId, key, .refused("The Mac didn't answer. Try again."))
                    return
                }
                guard result.sent, result.doc == SubagentFeed.doc(for: key), let feeds else {
                    self.settleSubagent(taskId, key, .refused(result.sent
                        ? "This Mac can't show a duckling's steps."
                        : (result.reason ?? "The Mac refused.")))
                    return
                }
                self.settleSubagent(taskId, key, .following)
                for await feed in feeds {
                    if Task.isCancelled { break }
                    guard let feed, feed.taskId == taskId, var current = self.subagent, current.task.id == taskId, current.key == key,
                          !PhoneSnapshot.isStale(feed.seq, than: current.feed?.seq) else { continue }
                    if current.feed != feed { current.feed = feed; self.subagent = current }
                }
            } catch {
                self?.settleSubagent(taskId, key, .refused("Couldn't reach the Mac. Try again."))
            }
        }
    }

    private func settleSubagent(_ taskId: String, _ key: String, _ phase: SubagentWatch.Phase) {
        guard subagent?.task.id == taskId, subagent?.key == key else { return }
        subagent?.phase = phase
    }

    /// Stop following: ends the read, and tells the Mac to delete the document (best effort; presence lapsing
    /// also ends it).
    func closeSubagent() {
        subagentTask?.cancel()
        subagentTask = nil
        guard let current = subagent else { return }
        subagent = nil
        guard !demo, let channel else { return }
        let key = current.key
        Task { [signer] in
            guard let (id, document) = try? await Task.detached(priority: .utility, operation: {
                try channel.subagentDocument(key: key, taskId: nil, signer: signer)
            }).value else { return }
            try? await channel.send(document, id: id)
            Task { await channel.deleteResult(id) }
        }
    }

    /* ---------- earlier messages ---------- */

    private func setHistory(_ state: ChatHistoryState, for key: String) {
        guard historyStates[key] != state else { return }
        historyStates[key] = state
        lastHistory[key] = state.entries
        historyStore?.record(state, for: key)
        if outbox[key] != nil { persistOutbox() }
    }

    /// The chat's live document has arrived with nothing more to wait for: its history is in it (or it has none
    /// to send), so the skeleton can stop even when that history is empty.
    func historyLanded(_ key: String) -> Bool {
        guard verbose, let turn = liveTurns[key] else { return false }
        return turn.history != nil || turn.split != true
    }

    /// What sits above the chat's first message: a sentinel, a spinner, "Start of chat" or a retry.
    func earlierRow(for session: PhoneSnapshot.Session) -> EarlierPaging.Row {
        EarlierPaging.row(available: earlierAvailable(session), state: historyStates[session.key], load: earlierLoad[session.key] ?? .idle,
                          catchingUp: catchingUp.contains(session.key))
    }

    private func earlierAvailable(_ session: PhoneSnapshot.Session) -> Bool {
        EarlierPaging.available(session: session, streamed: liveAvailable && verbose, demo: demo)
    }

    func cachedFrame(_ key: String) -> TimelineFrame? { timelineFrames.frame(for: key) }
    func keepFrame(_ frame: TimelineFrame, for key: String) { timelineFrames.keep(frame, for: key) }

    /// True while older messages have only just landed: the scroll view uses it to keep the reader's place.
    func justPrepended(_ key: String, now: Date = Date()) -> Bool {
        earlierPrependedAt[key].map { now.timeIntervalSince($0) < 2 } ?? false
    }

    /// Ask the Mac for the next older page of a chat. Read-only, so no Face ID, and asking again after an unclear
    /// failure is safe. `manual`: a tap or a pull, which may go again after a failure.
    func loadEarlier(_ session: PhoneSnapshot.Session, manual: Bool = false) async {
        let key = session.key
        let state = historyStates[key]
        guard EarlierPaging.shouldFetch(available: earlierAvailable(session), state: state, load: earlierLoad[key] ?? .idle, manual: manual,
                                        catchingUp: catchingUp.contains(key)),
              let state else { return }
        earlierLoad[key] = .loading
        let before = state.cursor
        guard let page = await fetchHistoryPage(key: key, before: before) else {
            earlierLoad[key] = .failed
            return
        }
        var next = historyStates[key] ?? state
        next.prepend(page)
        earlierPrependedAt[key] = Date()
        earlierLoad[key] = .idle
        setHistory(next, for: key)
        rebuild()
    }

    /// One page of a chat's history from the Mac, or nil when it could not be had. Read-only.
    private func fetchHistoryPage(key: String, before: String?) async -> HistoryPage? {
        guard let channel else { return nil }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.historyDocument(key: key, before: before, n: 12, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel), result.sent,
                  result.doc == LiveTurn.historyPageDoc(for: key, before: before),
                  let page = try await channel.historyPage(key: key, before: before),
                  EarlierPaging.matches(page, key: key, before: before) else { return nil }
            return page
        } catch {
            return nil
        }
    }

    /// Fills a hole in a chat's history (the phone was away while more than the live push carries happened): asks
    /// for the pages behind the push, newest first, until they join what was held. A failure stops quietly; the
    /// next live push finds the hole again and tries once more.
    func catchUp(_ session: PhoneSnapshot.Session) async {
        let key = session.key
        guard EarlierPaging.shouldCatchUp(available: earlierAvailable(session), state: historyStates[key], running: catchingUp.contains(key)) else { return }
        catchingUp.insert(key)
        defer { catchingUp.remove(key); rebuild() }
        for _ in 0..<EarlierPaging.catchUpPages {
            guard let gap = historyStates[key]?.gap else { return }
            guard let page = await fetchHistoryPage(key: key, before: gap.before) else { return }
            guard var next = historyStates[key], next.gap == gap else { continue }
            next.fill(page)
            setHistory(next, for: key)
            rebuild()
        }
    }

    @ObservationIgnored private var ticking = false
    /// A change arrived while a fetch was running; fetch once more after it.
    @ObservationIgnored private var tickAgain = false

    private func tickIfAwaitingApproval() async {
        if case .awaitingApproval = phase { await tick() }
    }

    /// Whether the Mac is answering, for the header, the bar and Settings.
    func macLiveness(now: Date = Date()) -> MacLiveness {
        demo ? (ProcessInfo.processInfo.arguments.contains("-squeak-demo-silent") ? .silent(since: now.addingTimeInterval(-37 * 60)) : .answering)
            : MacLiveness.read(aliveAt: macAliveAt, lookingSince: lookingSince, now: now)
    }

    @ObservationIgnored private var macNudge = NudgeGate(after: 30)

    /// The Mac staying unreachable while the app is on screen is offered to Heresay once per episode.
    private func observeMacForHeresay() {
        guard !demo else { return }
        let down: Date?
        if case .silent(let since) = macLiveness() { down = since } else { down = nil }
        if macNudge.observe(downSince: down) { HostSignals.trouble() }
    }

    private func heard(_ alive: MacAlive) {
        if macAliveAt.map({ alive.date > $0 }) ?? true { macAliveAt = alive.date }
    }

    /// A view straight from the stream.
    private func apply(_ next: PhoneSnapshot?) {
        guard phase == .paired else { return }
        snapshotEpoch += 1
        if let next, !PhoneSnapshot.isStale(next.seq, than: baseSnapshot?.seq) {
            baseSnapshot = next
            freshSnapshotAt = Date()
            learnLocal(from: next)
            rebuild()
        }
        lastFetch = Date()
        streamDownSince = nil
        problem = nil
    }

    /* ---------- replies you have not read ---------- */

    /// The agent has answered since you last looked at this chat, in a chat you have a stake in. A chat waiting on
    /// you has its own, louder mark, so it is never also "unread".
    func isUnread(_ session: PhoneSnapshot.Session) -> Bool {
        HomeLists.isUnread(session, seen: replySeen)
    }

    /// A finished chat remains bold in the project inbox until that chat is opened, including
    /// finished chats this phone has never opened. Opening only its project does not mark it read.
    func isProjectUnread(_ session: PhoneSnapshot.Session) -> Bool {
        ProjectInbox.isUnread(session, seen: replySeen)
    }

    /// Ponds with no chats, for the compact rows after the pond list.
    var emptyPonds: [PhoneSnapshot.Pond] { homeLists.emptyPonds }

    var projectInbox: [Presentation.Project] {
        let projects = homeLists.projects
        let starting = Set(projects.flatMap(\.sessions).filter {
            ChatTimeline.isStarting(session: $0, sends: outbox[$0.key] ?? [])
        }.map(\.key))
        return ProjectInbox.ordered(projects, seen: replySeen, starting: starting)
    }

    /// Chats with an unread reply, newest first, whether they are still active or went quiet.
    var unreadReplies: [PhoneSnapshot.Session] { homeLists.unread }

    /// Home's lists from the slice, the chats hidden here and what you have read. Recomputed when one of those changes,
    /// not on every read: a body asks several times.
    var homeLists: HomeLists {
        let slice = home, hidden = hiddenHere, seen = replySeen
        if let memo = listMemo, memo.version == homeVersion, memo.hidden == hidden, memo.seen == seen { return memo.lists }
        let lists = HomeLists.make(home: slice, hidden: hidden, seen: seen)
        listMemo = (homeVersion, hidden, seen, lists)
        return lists
    }

    /// You looked at the chat: what it said so far is read. Also the start of caring about its next reply.
    func markSeen(_ key: String) { replySeen[key] = Date().timeIntervalSince1970 }

    /// The view on screen from its parts. The merge and the comparison with what is on screen run in a detached task
    /// (they are pure); only what changed is published. The first view is built at once, a later one lands a hop
    /// later, and a newer rebuild drops an older one still running.
    private func rebuild() {
        guard let base = baseSnapshot else { return }
        let recent = recentDoc
        let live = watching.flatMap { liveTurns[$0] }
        let previousView = snapshot, previous = publishedSlices
        rebuildGeneration += 1
        let generation = rebuildGeneration
        guard previousView != nil else {
            publish(SnapshotPlan.make(view: base.merged(with: recent).reconciled(with: live), previousView: nil, previous: previous))
            return
        }
        Task.detached(priority: .userInitiated) { [weak self] in
            let plan = SnapshotPlan.make(view: base.merged(with: recent).reconciled(with: live), previousView: previousView, previous: previous)
            await MainActor.run { [weak self] in
                guard let self, generation == self.rebuildGeneration, self.baseSnapshot != nil else { return }
                self.publish(plan)
            }
        }
    }

    private func publish(_ plan: SnapshotPlan) {
        guard let view = plan.view else { return }
        seenSessions.record(view)
        // A chat seen working is one you are waiting on: its next reply is news.
        for session in view.sessions where session.state == "working" && replySeen[session.key] == nil {
            replySeen[session.key] = Date().timeIntervalSince1970
        }
        if plan.wholeChanged {
            publishing = true
            snapshot = view
            publishing = false
        }
        apply(plan)
        if freshSnapshotAt != nil { snapshotStore?.record(view) }
    }

    private func apply(_ plan: SnapshotPlan) {
        if plan.homeChanged { home = plan.slices.home }
        if !plan.changedSessions.isEmpty || !plan.removedSessions.isEmpty {
            sessionStore.apply(changed: plan.changedSessions, removed: plan.removedSessions)
        }
        if plan.controlsChanged { macControls = plan.slices.macControls }
        if plan.workStepsChanged { workSteps = plan.slices.workSteps }
        publishedSlices = plan.slices
    }

    /// The slices after `snapshot` was set directly.
    private func resyncSlices() {
        rebuildGeneration += 1  // an in-flight rebuild was diffed against what this replaces
        apply(SnapshotPlan.make(view: snapshot, previousView: nil, previous: publishedSlices))
    }

    /// Conductor's icon for a project, decoded once. Nil when the Mac sent none for it.
    func projectIcon(_ name: String) -> UIImage? { projectLogo(name)?.image }

    /// The icon with how it sits in a circle (`LogoFit`), measured once with the decode: icons are about
    /// 96 px, so reading their pixels costs well under a millisecond.
    func projectLogo(_ name: String) -> (image: UIImage, fit: LogoFit)? {
        guard let base64 = snapshot?.projectIcons?[name] else { return nil }
        if let cached = iconCache[name], cached.length == base64.count { return (cached.image, cached.fit) }
        guard let data = Data(base64Encoded: base64), let image = UIImage(data: data) else { return nil }
        let fit = LogoFit.of(image)
        iconCache[name] = (base64.count, image, fit)
        return (image, fit)
    }

    /// Whether the Mac is answering, so a "working" mark is not drawn moving for a Mac that went quiet.
    var macIsLive: Bool {
        if case .silent = macLiveness() { return false }
        return true
    }

    /// A session by key, active or recent, and for a short while after the Mac moved it between the two
    /// lists, so the chat on screen does not go blank in between.
    func session(_ key: String) -> PhoneSnapshot.Session? {
        sessionStore.session(key) ?? seenSessions.session(key)
    }

    /// Streamed: keep presence inside the Mac's window. No re-read: a quiet
    /// Mac is normal, and a dead stream reconnects by itself and is sent the
    /// whole view again. A presence write that lands proves the channel is
    /// up, so it counts as synced.
    private func keepAlive() async {
        guard let channel else { return }
        guard phase == .paired else { await tick(); return }
        do {
            try await channel.touchPresence(watching: presenceWatching, recent: recentAsk, calls: callsOpen)
            lastPresence = Date()
            problem = nil
        } catch {
            problem = "Can't reach Squeak's server right now."
        }
    }

    private func tick() async {
        guard channel != nil else { return }
        guard !ticking else { tickAgain = true; return }
        ticking = true
        repeat {
            tickAgain = false
            await fetch()
        } while tickAgain && !Task.isCancelled
        ticking = false
    }

    private func fetch() async {
        guard let channel else { return }
        do {
            if case .awaitingApproval = phase {
                if let answer = try await channel.pairingAnswer() {
                    if answer.approved {
                        KeyStore.save(Data("1".utf8), account: "approved")
                        if case let .awaitingApproval(_, mac) = phase { pairingCelebration = mac }
                        phase = .paired
                        startLocal(channel)
                    } else {
                        unpair()
                        problem = "Your Mac said no. Pair again if that was a mistake."
                        pairingFailure = .refused
                    }
                }
                return
            }
            // Tell the Mac someone is looking, so it publishes and polls faster. The write and the reads are
            // independent, so they go out together; the epoch check below still guards the snapshot.
            let epoch = snapshotEpoch
            let pingPresence = Date().timeIntervalSince(lastPresence) > MacLiveness.pingEvery
            let watchingNow = presenceWatching, recentNow = recentAsk
            let needsRecent = recentDoc == nil
            async let presence: Void = pingPresence ? channel.touchPresence(watching: watchingNow, recent: recentNow, calls: callsOpen) : ()
            async let snapshotRead = channel.snapshot()
            // Cold start has no recent list yet: ask for it speculatively (older Macs simply have none).
            async let recentRead = needsRecent ? (try? await channel.recent()) : nil
            async let aliveRead = try? await channel.alive()
            try await presence
            if pingPresence { lastPresence = Date() }
            let snapshotNow = try await snapshotRead
            let speculativeRecent = await recentRead
            let aliveNow = await aliveRead
            if let next = snapshotNow, epoch == snapshotEpoch {
                if next.split == true {
                    if let recent = speculativeRecent { recentDoc = recent }
                    else if !needsRecent, let recent = try await channel.recent() { recentDoc = recent }
                }
                if !PhoneSnapshot.isStale(next.seq, than: baseSnapshot?.seq) { baseSnapshot = next; learnLocal(from: next) }
                freshSnapshotAt = Date()
                rebuild()
            }
            // Best effort: an older Mac never answers, and that must not read as a broken channel.
            if let alive = aliveNow { heard(alive) }
            lastFetch = Date()
            observeMacForHeresay()
            problem = nil
            await reconcileRestored(on: channel)
        } catch ChannelCrypto.Failure.badBox, ChannelCrypto.Failure.badKey {
            problem = "This phone's pairing no longer matches your Mac. Pair again."
        } catch {
            problem = "Can't reach Squeak's server right now."
        }
    }

    /* ---------- replying ---------- */

    /// Sends a reply. `mode` only matters while the agent is mid-turn: queue waits for the turn to end,
    /// steer goes into it. The message is on screen at once as "Sending…" and settles to one of the delivery
    /// lines (`ChatSend.Status.line`). Returns false when nothing was sent (empty, or Face ID declined),
    /// so the composer can give the text back.
    @discardableResult
    func send(_ text: String, to session: PhoneSnapshot.Session, mode: ReplyMode = .queue) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        // Mode only means something mid-turn; an idle chat is simply sent.
        let mode: ReplyMode = session.state == "working" ? mode : .queue
        markSeen(session.key)
        // On screen first, like any chat app: the bubble ("Sending…") and the agent's "Starting…"
        // row appear on the tap, and Face ID, signing and the network all happen behind them.
        Haptics.play(mode == .steer ? .steer : .send)
        let sentId = begin(trimmed, for: session, mode: mode)
        guard await confirmWithBiometrics(reason: "Send to \(session.label)") else {
            withdraw(sentId, for: session)
            return false
        }
        let agent = Presentation.agentName(session.agent)
        if demo {
            try? await Task.sleep(for: .seconds(1))
            let working = session.state == "working"
            finish(sentId, !working ? .sent : mode == .steer ? .steered : .queued(agent: agent, steerUnavailable: false), for: session)
            return true
        }
        await deliver(sentId, to: session, mode: mode)
        return true
    }

    /// How long a send waits for the Mac before it stops waiting and says so.
    static let resultWait: TimeInterval = 30
    /// After taking a silent command back, how long a Mac that had just read it gets to answer anyway.
    static let lateResultWait: TimeInterval = 12

    /// Puts send `sentId` on the channel and settles its bubble to what is proven, and only that:
    /// the Mac's "sent" is delivered; its "not sent", a failed write, and a command the Mac never read are
    /// "Not sent, nothing started"; "unconfirmed", and silence that could not be undone, are "Couldn't confirm".
    private func deliver(_ sentId: UUID, to session: PhoneSnapshot.Session, mode: ReplyMode) async {
        guard let send = outbox[session.key]?.first(where: { $0.id == sentId }) else { return }
        let agent = Presentation.agentName(session.agent)
        guard let channel else { finish(sentId, .refused("this phone isn't connected to your Mac."), for: session); return }
        let text = send.text, messageId = send.messageId
        // Mid-turn the mode is always named, so the Mac's shared default can never turn a queue into a steer.
        let explicit = session.state == "working"
        let id: String
        do {
            let signer = signer
            let (commandId, document) = try await Task.detached(priority: .userInitiated) {
                try channel.replyDocument(to: session, text: text, mode: mode, messageId: messageId, explicitMode: explicit, signer: signer)
            }.value
            id = commandId
            setCommand(id, for: sentId, in: session.key)
            try await channel.send(document, id: id)
            if let i = outbox[session.key]?.firstIndex(where: { $0.id == sentId }) { outbox[session.key]?[i].onChannel = true }
        } catch {
            // The write may have landed even though the answer to it did not: take it back before saying "not sent".
            if let commandId = outbox[session.key]?.first(where: { $0.id == sentId })?.commandId, !(await channel.deleteCommand(commandId)) {
                finish(sentId, .notConfirmed, for: session)
            } else {
                finish(sentId, .refused("Couldn't reach your Mac's server. \(error.localizedDescription)"), for: session)
            }
            return
        }
        // The Mac answers within a few seconds while this app is open.
        let result: CommandResult?
        do { result = try await awaitResult(id, on: channel, within: Self.resultWait) } catch { result = nil }
        if let result {
            settle(sentId, with: result, agent: agent, for: session)
            return
        }
        // Silence. Take the command back so it can never run later, then give a Mac that had just read it a
        // moment: whatever it says is the truth. Nothing at all and the command gone means it never started.
        let withdrawn = await channel.deleteCommand(id)
        if let late = try? await awaitResult(id, on: channel, within: withdrawn ? Self.lateResultWait : 1) {
            settle(sentId, with: late, agent: agent, for: session)
        } else {
            finish(sentId, .silence(withdrawn: withdrawn), for: session)
        }
    }

    private func settle(_ sentId: UUID, with result: CommandResult, agent: String, for session: PhoneSnapshot.Session) {
        finish(sentId, .verdict(result, agent: agent), for: session)
    }

    /// Sends a message that did not go through again, under the same Conductor id (so Conductor does not
    /// take it twice if the first try did arrive). Face ID first, like any send.
    func retry(_ sentId: UUID, in session: PhoneSnapshot.Session) async {
        guard let i = outbox[session.key]?.firstIndex(where: { $0.id == sentId }), outbox[session.key]![i].status.failed else { return }
        // "Sending…" on the tap, Face ID behind it; a declined Face ID puts the failure back.
        Haptics.play(.send)
        let before = outbox[session.key]![i]
        outbox[session.key]?[i].status = .sending
        outbox[session.key]?[i].date = Date()
        guard await confirmWithBiometrics(reason: "Send to \(session.label)") else {
            if let j = outbox[session.key]?.firstIndex(where: { $0.id == sentId }) { outbox[session.key]?[j] = before }
            return
        }
        guard let i = outbox[session.key]?.firstIndex(where: { $0.id == sentId }) else { return }
        outbox[session.key]?[i].commandId = nil
        outbox[session.key]?[i].onChannel = false
        let mode = outbox[session.key]![i].mode
        persistOutbox()
        if demo {
            try? await Task.sleep(for: .seconds(1))
            finish(sentId, .sent, for: session)
            return
        }
        await deliver(sentId, to: session, mode: session.state == "working" ? mode : .queue)
    }

    /// Takes a message that did not go through out of the chat and puts its text back in the composer.
    func edit(_ sentId: UUID, in session: PhoneSnapshot.Session) {
        guard let send = outbox[session.key]?.first(where: { $0.id == sentId }), send.status.failed else { return }
        outbox[session.key]?.removeAll { $0.id == sentId }
        persistOutbox()
        restoredDraft[session.key] = send.text
    }

    /// The composer took the restored text.
    func draftRestored(for key: String) { restoredDraft[key] = nil }

    private func setCommand(_ commandId: String, for sentId: UUID, in key: String) {
        guard let i = outbox[key]?.firstIndex(where: { $0.id == sentId }) else { return }
        outbox[key]?[i].commandId = commandId
        persistOutbox()
    }

    /* ---------- the outbox on disk ---------- */

    /// What is kept: sends not delivered. A "Sending…" that survived a relaunch is unknown, not in flight.
    private func persistOutbox() {
        // Settled failures go by age, and the chat's history proves or disproves an unconfirmed one.
        for (key, sends) in outbox {
            let kept = OutboxPolicy.prune(sends, history: lastHistory[key], offset: clockSkew.offset)
            if kept != sends { outbox[key] = kept.isEmpty ? nil : kept }
        }
        guard let outboxStore else { return }
        var entries: [OutboxStore.Entry] = []
        for (key, sends) in outbox {
            for s in sends {
                let state: OutboxStore.Entry.State, reason: String?
                switch s.status {
                case .sending: state = .sending; reason = nil
                case .refused(let why): state = .refused; reason = why
                case .notConfirmed: state = .unconfirmed; reason = nil
                default: continue
                }
                entries.append(OutboxStore.Entry(
                    key: key, id: s.id.uuidString, text: s.text, at: s.origin.timeIntervalSince1970, answersTurn: s.answersTurn,
                    messageId: s.messageId, mode: s.mode == .steer ? "steer" : "queue", queuedBehindTurn: s.queuedBehindTurn,
                    state: state, reason: reason, commandId: s.commandId))
            }
        }
        outboxStore.replace(with: entries.sorted { $0.at < $1.at })
    }

    private static func restore(_ entries: [OutboxStore.Entry]) -> [String: [ChatSend]] {
        var out: [String: [ChatSend]] = [:]
        for e in entries {
            let status: ChatSend.Status
            switch e.state {
            case .sending, .unconfirmed: status = .notConfirmed
            case .refused: status = .refused(e.reason ?? "your Mac refused that reply.")
            }
            var send = ChatSend(id: UUID(uuidString: e.id) ?? UUID(), text: e.text, date: Date(timeIntervalSince1970: e.at),
                                answersTurn: e.answersTurn, status: status, messageId: e.messageId,
                                mode: e.mode == "steer" ? .steer : .queue, queuedBehindTurn: e.queuedBehindTurn)
            send.commandId = e.commandId
            out[e.key, default: []].append(send)
        }
        return out
    }

    /// Once per launch: a send the app lost sight of (killed mid-send) may have an answer waiting on the channel.
    private func reconcileRestored(on channel: Channel) async {
        guard unreconciled else { return }
        unreconciled = false
        for (key, sends) in outbox {
            for send in sends where send.status == .notConfirmed {
                guard let commandId = send.commandId, let result = try? await channel.result(for: commandId) else { continue }
                guard let session = session(key) else { continue }
                Task { await channel.deleteResult(commandId) }
                settle(send.id, with: result, agent: Presentation.agentName(session.agent), for: session)
            }
        }
    }

    /// The Mac's answer to command `id`, or nil after 30 seconds. Streamed, it
    /// is read the moment the Mac writes it; otherwise every 750 ms.
    func awaitResult(_ id: String, on channel: Channel, within seconds: TimeInterval = 30, quiet: Bool = false) async throws -> CommandResult? {
        // A long wait is listed so the screen can say "Still waiting…" and offer Cancel (`cancelWait`).
        if !quiet { waits[id] = Date() }
        defer { waits[id] = nil; cancelledWaits.remove(id) }
        let result = try await withThrowingTaskGroup(of: CommandResult?.self) { group in
            group.addTask { [weak self] in try await self?.readResult(id, on: channel, within: seconds) }
            group.addTask { [weak self] in
                // Cancel stops waiting here and nothing more: the command itself is not taken back.
                while !Task.isCancelled {
                    try await Task.sleep(for: .milliseconds(200))
                    if await self?.cancelledWaits.contains(id) == true { return nil }
                }
                return nil
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }
        // Read: it has nothing more to say, and every stream on `results` would download it again.
        if result != nil { Task { await channel.deleteResult(id) } }
        else if !quiet, !cancelledWaits.contains(id) { HostSignals.trouble() }
        return result
    }

    /// Commands this phone is waiting on the Mac for, by id, with when each began.
    private(set) var waits: [String: Date] = [:]
    @ObservationIgnored private(set) var cancelledWaits: Set<String> = []

    /// Stops waiting for command `id` on this phone. It does not claim the Mac did not, or will not, run it.
    func cancelWait(_ id: String) { if waits[id] != nil { cancelledWaits.insert(id) } }

    /// The oldest wait that has run long enough to say so.
    func longWait(now: Date = Date()) -> (id: String, since: Date)? {
        waits.filter { WaitHint.isLong(since: $0.value, now: now) }.min { $0.value < $1.value }.map { ($0.key, $0.value) }
    }

    private func readResult(_ id: String, on channel: Channel, within seconds: TimeInterval = 30) async throws -> CommandResult? {
        let found = try await readStamped(id, on: channel, within: seconds)
        // Read as it arrived: the Mac's stamp on it against this phone's clock is the skew between them.
        if let found, let at = found.macAt { clockSkew.observe(macMillis: at, receivedAt: Date()) }
        return found?.result
    }

    private func readStamped(_ id: String, on channel: Channel, within seconds: TimeInterval) async throws -> (result: CommandResult, macAt: Int64?)? {
        let deadline = Date().addingTimeInterval(seconds)
        guard let changes = await channel.resultChanges() else {
            while Date() < deadline {
                try await Task.sleep(for: .milliseconds(750))
                if let result = try await channel.stampedResult(for: id) { return result }
            }
            return nil
        }
        return try await withThrowingTaskGroup(of: (result: CommandResult, macAt: Int64?)?.self) { group in
            group.addTask {
                for await _ in changes {
                    if let result = try await channel.stampedResult(for: id) { return result }
                }
                return nil
            }
            group.addTask {
                try await Task.sleep(for: .seconds(deadline.timeIntervalSinceNow))
                return try await channel.stampedResult(for: id) // one last look
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /* ---------- starting a chat ---------- */

    /// Asks the Mac to start a chat in `workspace`. Face ID first, like a reply. On success the new chat
    /// is opened as soon as the snapshot has it (`SqueakRouter`), and the list shows "Starting…" until then.
    func startChat(in workspace: PhoneSnapshot.Workspace, agent: NewChatAgent, text: String,
                   model: String? = nil, thinking: String? = nil, split: WorkSplit? = nil) async -> StartResult {
        guard await confirmWithBiometrics(reason: "Start a chat in \(workspace.label)") else { return .cancelled }
        if demo {
            try? await Task.sleep(for: .seconds(1))
            let id = UUID().uuidString.lowercased()
            accept(sessionId: id, label: workspace.label)
            try? await Task.sleep(for: .seconds(2))
            if let current = snapshot {
                let session = PhoneSnapshot.Session(
                    key: "new-\(id)", conductorSessionId: id, label: workspace.label, agent: agent.rawValue, state: "working",
                    lastActivityAt: ISO8601DateFormatter().string(from: Date()), detail: "Reading the request", git: nil,
                    contextPercent: nil, turnId: nil, message: nil, choices: nil)
                snapshot = PhoneSnapshot(
                    v: current.v, mac: current.mac, generatedAt: current.generatedAt, duck: current.duck,
                    sessions: [session] + current.sessions, usage: current.usage, workspaces: current.workspaces,
                    recent: current.recent, keepAwake: current.keepAwake, awakeUntil: current.awakeUntil,
                        awakeLid: current.awakeLid, awakeLidProblem: current.awakeLidProblem, awakeLidReady: current.awakeLidReady,
                        awakeSafety: current.awakeSafety, macPower: current.macPower,
                        awakeLidActions: current.awakeLidActions, awakeRules: current.awakeRules,
                        awakeLastEnd: current.awakeLastEnd, awakeSleepProblem: current.awakeSleepProblem)
            }
            return .started
        }
        guard let channel else { return .refused("This iPhone isn't connected to your Mac.") }
        do {
            let signer = signer, workspaceId = workspace.id
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.startDocument(workspaceId: workspaceId, agent: agent, text: text, model: model, thinking: thinking, split: split, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                return .refused("Your Mac didn't confirm. If a new chat appears in Sessions it worked, so don't send this again.")
            }
            guard result.sent else { return .refused(result.reason ?? "Your Mac refused to start that chat.") }
            if let sessionId = result.sessionId { accept(sessionId: sessionId, label: workspace.label) }
            return .started
        } catch {
            return .refused("Couldn't reach your Mac: \(error.localizedDescription)")
        }
    }

    private func accept(sessionId: String, label: String) {
        startingChat = StartingChat(sessionId: sessionId, label: label)
        SqueakRouter.shared.open(sessionId: sessionId)
        // A chat that never appears (Conductor failed to make it) must not spin forever.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(90))
            if self?.startingChat?.sessionId == sessionId { self?.startingChat = nil }
        }
    }

    private func settleStarting(_ snapshot: PhoneSnapshot?) {
        guard let starting = startingChat, snapshot?.sessions.contains(where: { $0.conductorSessionId == starting.sessionId }) == true else { return }
        startingChat = nil
    }

    /// Answers a Squeak (native) chat's open request: allow once or for the chat, deny with a note, or pick an
    /// option. Face ID first, like any answer. The Mac matches it against the session host's current request, so a
    /// tap on a request that has already been answered comes back refused with a plain sentence.
    func respondNative(_ decision: NativeDecision, to session: PhoneSnapshot.Session) async -> (delivered: Bool, line: String) {
        guard let request = session.nativeRequest else { return (false, "That isn't waiting on you any more.") }
        Haptics.play(.answer)
        guard await confirmWithBiometrics(reason: "Answer in \(session.label)") else { return (false, "") }
        if demo {
            try? await Task.sleep(for: .seconds(1))
            Haptics.play(.confirmed)
            return (true, NativeWords.confirmation(decision, kind: request.kind))
        }
        guard let channel else { return (false, "Not connected to your Mac.") }
        do {
            let signer = signer, key = session.key, requestId = request.id
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.nativeRespondDocument(sessionKey: key, requestId: requestId, decision: decision, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                Haptics.play(.notConfirmed)
                return (false, "Your Mac didn't confirm it. Check the chat before answering again.")
            }
            guard result.sent else {
                Haptics.play(.refused)
                return (false, result.reason ?? "Your Mac couldn't deliver that answer.")
            }
            Haptics.play(.confirmed)
            return (true, NativeWords.confirmation(decision, kind: request.kind))
        } catch {
            return (false, "Couldn't reach your Mac.")
        }
    }

    /// Asks the Mac to start a Squeak (native) chat. Face ID first, like a reply; the Mac checks the project,
    /// the model and the permission mode again.
    func startNativeChat(_ start: NativeStart, label: String) async -> StartResult {
        guard await confirmWithBiometrics(reason: "Start a chat in \(label)") else { return .cancelled }
        if demo {
            try? await Task.sleep(for: .seconds(1))
            return .started
        }
        guard let channel else { return .refused("This iPhone isn't connected to your Mac.") }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.nativeStartDocument(start, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                return .refused("Your Mac didn't confirm. If a new chat appears in Sessions it worked, so don't send this again.")
            }
            guard result.sent else { return .refused(result.reason ?? "Your Mac refused to start that chat.") }
            return .started
        } catch {
            return .refused("Couldn't reach your Mac: \(error.localizedDescription)")
        }
    }

    /// Asks the Mac for a fresh Claude usage reading; the new numbers arrive in
    /// the snapshot. No Face ID: it reads, and sends nothing to an agent.
    /// Returns a line for the screen.
    /// Answers the question a chat is waiting on (ANSWER-CARD). Face ID first, like a reply: it is
    /// words to an agent. Returns the line to show under the card, and whether it was delivered.
    func answer(_ answers: [AnswerCommand.Answer]?, plan: AnswerCommand.PlanAnswer? = nil, to session: PhoneSnapshot.Session) async -> (delivered: Bool, line: String) {
        guard let toolUseId = session.question?.toolUseId, let sessionId = session.conductorSessionId else {
            return (false, "Your Mac can't take answers from this phone yet. Update Squeak on your Mac.")
        }
        Haptics.play(.answer)
        guard await confirmWithBiometrics(reason: "Answer in \(session.label)") else { return (false, "") }
        if demo {
            try? await Task.sleep(for: .seconds(1))
            Haptics.play(.confirmed)
            return (true, "Answered")
        }
        guard let channel else { return (false, "Not connected to your Mac.") }
        do {
            let (id, document) = try channel.answerDocument(sessionId: sessionId, toolUseId: toolUseId, answers: answers, plan: plan, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                Haptics.play(.notConfirmed)
                return (false, "Your Mac didn't confirm it. Check the chat before answering again.")
            }
            guard result.answered || result.sent else {
                Haptics.play(.refused)
                return (false, result.reason ?? "Your Mac couldn't deliver that answer.")
            }
            Haptics.play(.confirmed)
            let how = result.via == "stopped-and-sent" ? " · sent as a message after stopping the question" : ""
            return (true, (result.note ?? "Answered") + how)
        } catch {
            return (false, "Couldn't reach your Mac.")
        }
    }

    /// Make a film's call (RasanAI): pick an option, ask for more, or answer its question. Face ID
    /// first, like any answer; the Mac checks it against the film as it is on disk.
    /// A note on the animatic or the film doesn't close the call, so it skips Face ID; applying the
    /// notes, approving and rendering do not.
    func act(on session: PhoneSnapshot.Session, type: String, value: WorkflowCommand.Value?, note: String? = nil) async -> (delivered: Bool, line: String) {
        guard let workflow = session.workflow else { return (false, "That isn't waiting on you any more.") }
        return await act(on: .session(session), workflow: workflow, type: type, value: value, note: note)
    }

    /// The same for a call on either kind of card: a chat's film card, or a film of its own.
    func act(on owner: WorkflowOwner, workflow: Workflow, type: String, value: WorkflowCommand.Value?, note: String? = nil) async -> (delivered: Bool, line: String) {
        switch owner {
        case let .film(film):
            return await act(on: film, workflow: workflow, type: type, value: JSONValue(value), note: note)
        case let .session(session):
            Haptics.play(.answer)
            if type != "comment" {
                guard await confirmWithBiometrics(reason: "Answer \(workflow.title ?? "your film")") else { return (false, "") }
            }
            if demo {
                try? await Task.sleep(for: .seconds(1))
                Haptics.play(.confirmed)
                return (true, "Sent to RasanAI")
            }
            guard let channel else { return (false, "Not connected to your Mac.") }
            do {
                let (id, document) = try channel.workflowDocument(
                    sessionKey: session.key, workflow: workflow, type: type, value: value, note: note, signer: signer)
                try await channel.send(document, id: id)
                guard let result = try await awaitResult(id, on: channel) else {
                    Haptics.play(.notConfirmed)
                    return (false, "Your Mac didn't confirm it. Check the film before answering again.")
                }
                guard result.sent else {
                    Haptics.play(.refused)
                    return (false, result.reason ?? "Your Mac couldn't send that to RasanAI.")
                }
                Haptics.play(.confirmed)
                return (true, (result.said ?? "Sent") + " · RasanAI picks it up from here")
            } catch {
                return (false, "Couldn't reach your Mac.")
            }
        }
    }

    /* ---------- films (RasanAI, independent of any chat) ---------- */

    /// The film as the Mac last said it.
    func film(_ id: String) -> PhoneFilm? { snapshot?.film(id) }

    /// Answer a film's waiting call (a brief's form, a pick, a styleframe verdict, a question): signed, with the
    /// step and revision the phone saw, so the Mac refuses it if the call has moved on. Face ID first, except for a
    /// comment, which leaves the call open.
    func act(on film: PhoneFilm, workflow: Workflow, type: String, value: JSONValue?, note: String? = nil) async -> (delivered: Bool, line: String) {
        Haptics.play(.answer)
        if type != "comment" {
            guard await confirmWithBiometrics(reason: "Answer \(film.title)") else { return (false, "") }
        }
        if demo {
            try? await Task.sleep(for: .seconds(1))
            Haptics.play(.confirmed)
            return (true, "Sent to RasanAI")
        }
        return await sendFilm(film, op: .answer, step: workflow.step, revision: workflow.revision, type: type, value: value, note: note) { $0 ?? "Sent" }
    }

    /// Send one signed film command and wait for the Mac's word. `said` turns the Mac's own sentence (if any) into the line shown.
    private func sendFilm(
        _ film: PhoneFilm, op: FilmCommand.Op, step: String? = nil, revision: String? = nil, type: String? = nil,
        value: JSONValue? = nil, note: String? = nil, text: String? = nil, askId: String? = nil, tool: String? = nil,
        line said: (String?) -> String
    ) async -> (delivered: Bool, line: String) {
        guard let channel else { return (false, "Not connected to your Mac.") }
        do {
            let (id, document) = try channel.filmDocument(
                filmId: film.id, op: op, step: step, revision: revision, type: type, value: value, note: note,
                text: text, askId: askId, tool: tool, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel, within: op == .resume || op == .stop ? 40 : 30) else {
                Haptics.play(.notConfirmed)
                return (false, "Your Mac didn't confirm it. Check the film before trying again.")
            }
            guard result.sent else {
                Haptics.play(.refused)
                return (false, result.reason ?? "Your Mac couldn't send that to RasanAI.")
            }
            Haptics.play(.confirmed)
            return (true, said(result.said ?? result.note))
        } catch {
            return (false, "Couldn't reach your Mac.")
        }
    }

    /// What was typed to Rasan on this phone and the Mac's thread does not show yet, per film.
    private(set) var filmChatLocal: [String: [FilmChat.Local]] = [:]

    /// The Ask Rasan thread as it reads now: the Mac's lines, then what is still on its way.
    func filmChatRows(_ film: PhoneFilm) -> [FilmChat.Row] {
        FilmChat.rows(server: film.chat, local: filmChatLocal[film.id] ?? [])
    }

    /// Drop typed lines the Mac's thread has caught up with; called when a view of the film arrives.
    func settleFilmChat() {
        for film in snapshot?.films ?? [] {
            guard let local = filmChatLocal[film.id] else { continue }
            let kept = FilmChat.settled(server: film.chat, local: local)
            if kept != local { filmChatLocal[film.id] = kept.isEmpty ? nil : kept }
        }
    }

    /// Say something to Rasan (the director's Ask Rasan chat). The line shows at once and stays until the Mac's
    /// thread has it; a failure keeps it, with the reason and a way to send it again.
    func sendFilmChat(_ film: PhoneFilm, text: String, retrying: UUID? = nil) async {
        let words = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        guard !words.isEmpty else { return }
        var list = filmChatLocal[film.id] ?? []
        let id: UUID
        if let retrying, let i = list.firstIndex(where: { $0.id == retrying }) {
            id = retrying; list[i].state = .sending
        } else {
            let item = FilmChat.Local(text: words); id = item.id; list.append(item)
        }
        filmChatLocal[film.id] = list
        Haptics.play(.send)
        func mark(_ state: FilmChat.Local.State) {
            guard var list = filmChatLocal[film.id], let i = list.firstIndex(where: { $0.id == id }) else { return }
            list[i].state = state
            filmChatLocal[film.id] = list
        }
        if demo {
            try? await Task.sleep(for: .milliseconds(700))
            mark(.sent)
            return
        }
        let outcome = await sendFilm(film, op: .chat, text: words) { $0 ?? "Sent" }
        mark(outcome.delivered ? .sent : .failed(outcome.line.isEmpty ? "Couldn't send it." : outcome.line))
    }

    /// Wake the film's director (resume or thaw) or stop it, as RasanAI Studio's buttons do. Returns the line to show.
    func filmDirector(_ film: PhoneFilm, resume: Bool) async -> (delivered: Bool, line: String) {
        Haptics.play(resume ? .approve : .stop)
        if demo {
            try? await Task.sleep(for: .seconds(1))
            return (true, resume ? "Waking the director." : "Stopped.")
        }
        return await sendFilm(film, op: resume ? .resume : .stop) { $0 ?? (resume ? "Waking the director." : "Stopped.") }
    }

    /// Have the Mac install the tool a missing-tool question asks for, then answer it. Can take minutes; the
    /// Mac says "Installing …" at once and reports the finish itself.
    func installTool(_ film: PhoneFilm, workflow: Workflow, tool: Workflow.ToolAsk) async -> (delivered: Bool, line: String) {
        Haptics.play(.answer)
        guard await confirmWithBiometrics(reason: "Install \(tool.label) on your Mac") else { return (false, "") }
        if demo {
            try? await Task.sleep(for: .seconds(1))
            return (true, "Installing \(tool.label)…")
        }
        return await sendFilm(film, op: .installTool, askId: workflow.ask?.id, tool: tool.tool) { $0 ?? "Installing \(tool.label)…" }
    }

    func refreshUsage() async -> String {
        if demo { try? await Task.sleep(for: .seconds(1)); return "Updated just now." }
        guard let channel else { return "Not connected to your Mac." }
        do {
            let (id, document) = try channel.usageDocument(signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            guard result.sent else { return result.reason ?? "Your Mac couldn't refresh usage." }
            if let note = result.note { return note }
            return result.throttled == true ? "Already up to date: read in the last minute." : "Updated just now."
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /* ---------- keep the Mac awake ---------- */

    /// The Mac's awake session as this phone shows it.
    struct AwakeStatus: Equatable {
        /// Nil: until it is ended.
        var until: Date?
        /// "on", "starting" or "failed" for a lid-closed session; nil without the lid.
        var lid: String? = nil
        var lidProblem: String? = nil
        /// A safety rule acting now.
        var safety: String? = nil
        /// Asked for on this phone and not yet confirmed by the Mac's own snapshot.
        var pending = false
    }

    enum AwakeChange {
        case start(minutes: Int?, lid: Bool = false)
        case extend(minutes: Int)
        case end
    }

    /// The session as last changed here, shown until the Mac's snapshot has had time to agree.
    private var awakeTapped: (change: AwakeChange, status: AwakeStatus?, at: Date)?
    /// Bumped when a tapped session's wait runs out, so the screen draws what the Mac says without waiting for news.
    private var awakeTick = 0

    /// Whether this Mac offers awake sessions at all.
    var awakeOffered: Bool { snapshot?.keepAwake != nil }

    /// Whether this Mac can start a lid-closed session.
    var awakeLidReady: Bool { snapshot?.awakeLidReady == true }

    /// The running awake session, or nil when there is none. What this phone just asked for shows only until the
    /// Mac's snapshot has caught up with it: from then on the Mac's own word is what is drawn, so "Turning on…"
    /// gives way to "On" the moment the Mac says so, and never hides the real state.
    var awake: AwakeStatus? {
        _ = awakeTick
        let mac: AwakeStatus? = snapshot?.keepAwake == true
            ? AwakeStatus(until: snapshot?.awakeUntil.flatMap(Self.parseISO), lid: snapshot?.awakeLid,
                          lidProblem: snapshot?.awakeLidProblem, safety: snapshot?.awakeSafety)
            : nil
        guard let tapped = awakeTapped else { return mac }
        let age = Date().timeIntervalSince(tapped.at)
        switch tapped.change {
        case .start(_, let lid):
            if let mac, !lid || mac.lid != nil { return mac }
            return age < 45 ? tapped.status : mac
        case .extend:
            if let mac, let now = mac.until, let want = tapped.status?.until, now >= want.addingTimeInterval(-90) { return mac }
            return age < 20 ? tapped.status : mac
        case .end:
            if mac == nil { return nil }
            return age < 20 ? nil : mac
        }
    }

    /// Redraws once the phone's own expectation has run out (see `awake`).
    private func expireAwakeTap() {
        Task { [weak self] in
            for delay in [21.0, 25.0] {
                try? await Task.sleep(for: .seconds(delay))
                self?.awakeTick += 1
            }
        }
    }

    /// "1h 23m" / "45m" / "under a minute" until `until`.
    static func awakeLeft(_ until: Date, now: Date = Date()) -> String { AwakeFormat.left(until, now: now) }

    private static func parseISO(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /* ---------- what a closed lid does ---------- */

    /// Switches this phone just flipped, by "<mode>.<key>", shown until the Mac's own snapshot agrees or 20 seconds pass.
    private var lidActionTaps: [String: (value: Bool, at: Date)] = [:]
    private var lidActionTick = 0

    /// Whether this Mac sends what a closed lid does (an older one does not, and the group is hidden).
    var lidActionsOffered: Bool { snapshot?.awakeLidActions != nil }
    /// Whether this Mac has the two modes, lid open and lid closed, each with its own switches.
    var awakeModesOffered: Bool { snapshot?.awakeOpenActions != nil }

    /// The Mac's lid-closed settings with this phone's unconfirmed taps laid over them.
    var lidActions: PhoneSnapshot.LidActions? {
        _ = lidActionTick
        guard var actions = snapshot?.awakeLidActions else { return nil }
        for (key, tap) in lidActionTaps where key.hasPrefix("closed.") && Date().timeIntervalSince(tap.at) < 20 {
            actions[String(key.dropFirst("closed.".count))] = tap.value
        }
        return actions
    }

    /// The Mac's lid-open settings with this phone's unconfirmed taps laid over them.
    var openActions: PhoneSnapshot.OpenActions? {
        _ = lidActionTick
        guard var actions = snapshot?.awakeOpenActions else { return nil }
        for (key, tap) in lidActionTaps where key.hasPrefix("open.") && Date().timeIntervalSince(tap.at) < 20 {
            actions[String(key.dropFirst("open.".count))] = tap.value
        }
        return actions
    }

    /// One switch of either mode, as shown.
    func awakeSwitch(_ key: String, open: Bool) -> Bool {
        open ? (openActions?[key] ?? false) : (lidActions?[key] ?? false)
    }

    private func macValue(_ key: String, open: Bool) -> Bool? {
        open ? snapshot?.awakeOpenActions?[key] : snapshot?.awakeLidActions?[key]
    }

    /// Whether a flip is waiting on the Mac.
    func lidActionPending(_ key: String, open: Bool = false) -> Bool {
        _ = lidActionTick
        guard let tap = lidActionTaps["\(open ? "open" : "closed").\(key)"] else { return false }
        return Date().timeIntervalSince(tap.at) < 20 && macValue(key, open: open) != tap.value
    }

    /// Turns one switch of a mode on or off: what a closed lid does, or with `open` what a session does while the
    /// lid is open. No Face ID: it is a Mac setting, reaches no agent and carries no words. Returns a reason on
    /// failure, after putting the switch back.
    func changeLidAction(_ key: String, _ on: Bool, open: Bool = false) async -> String? {
        let tapKey = "\(open ? "open" : "closed").\(key)"
        lidActionTaps[tapKey] = (on, Date())
        lidActionTick += 1
        let expire = { [weak self] in
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(21))
                self?.lidActionTick += 1
            }
        }
        expire()
        if demo {
            // No Mac to ask: the demo keeps what was tapped.
            if open, var current = snapshot?.awakeOpenActions { current[key] = on; snapshot?.awakeOpenActions = current }
            if !open, var current = snapshot?.awakeLidActions { current[key] = on; snapshot?.awakeLidActions = current }
            lidActionTaps[tapKey] = nil
            return nil
        }
        func fail(_ reason: String) -> String {
            lidActionTaps[tapKey] = nil
            lidActionTick += 1
            return reason
        }
        guard let channel else { return fail("Not connected to your Mac.") }
        var change = LidActionsCommand.Settings()
        switch key {
        case "displayOff": change.displayOff = on
        case "screenOn": change.screenOn = on
        case "mute": change.mute = on
        case "lowPower": change.lowPower = on
        default: change.freezeApps = on
        }
        do {
            let (id, document) = try channel.lidActionsDocument(change, open: open, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return fail("Your Mac didn't answer. Is Squeak running?") }
            guard result.sent else { return fail(result.reason ?? "Your Mac couldn't change that.") }
            await refresh()
            return nil
        } catch {
            return fail("Couldn't reach your Mac.")
        }
    }

    /* ---------- notification settings ---------- */

    /// Changes this phone just made, by "<channel>.<key>", shown until the Mac's own snapshot agrees or 20 seconds pass.
    private var notifyTaps: [String: (change: NotifyChange, at: Date)] = [:]
    private var notifyTick = 0

    /// Whether this Mac sends notification settings (an older one does not, and the page is hidden).
    var notifyOffered: Bool { snapshot?.notify != nil }

    /// A channel's settings as shown: the Mac's, with this phone's unconfirmed changes laid over them.
    func notifySettings(_ channel: String) -> NotifySettings.ChannelSettings? {
        _ = notifyTick
        guard var settings = snapshot?.notify?[channel] else { return nil }
        for (key, tap) in notifyTaps where key.hasPrefix(channel + ".") && Date().timeIntervalSince(tap.at) < 20 {
            tap.change.apply(to: &settings)
        }
        return settings
    }

    /// Changes one setting of "telegram" or "cliq". No Face ID: it is a Mac setting, reaches no agent and carries
    /// no words. Shows the change at once; returns the Mac's reason on a refusal, after putting the old value back.
    func changeNotify(_ channel: String, _ change: NotifyChange) async -> String? {
        let tapKey = "\(channel).\(change.key)"
        notifyTaps[tapKey] = (change, Date())
        notifyTick += 1
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(21))
            self?.notifyTick += 1
        }
        if demo {
            if var settings = snapshot?.notify?[channel] {
                change.apply(to: &settings)
                snapshot?.notify?[channel] = settings
            }
            notifyTaps[tapKey] = nil
            return nil
        }
        func fail(_ reason: String) -> String {
            notifyTaps[tapKey] = nil
            notifyTick += 1
            return reason
        }
        guard let channelStore = self.channel else { return fail("Not connected to your Mac.") }
        do {
            let (id, document) = try channelStore.notifyDocument(channel: channel, change, signer: signer)
            try await channelStore.send(document, id: id)
            guard let result = try await awaitResult(id, on: channelStore) else { return fail("Your Mac didn't answer. Is Squeak running?") }
            guard result.sent else { return fail(result.reason ?? "Your Mac couldn't change that.") }
            await refresh()
            return nil
        } catch {
            return fail("Couldn't reach your Mac.")
        }
    }

    /* ---------- send default ---------- */

    /// A change this phone just made, shown until the Mac's own view agrees or 20 seconds pass.
    private var sendDefaultTap: (mode: ReplyMode, at: Date)?
    private var sendDefaultTick = 0
    private(set) var sendDefaultSaving = false

    /// Whether this Mac has the shared send default (an older one does not: Queue stays the round button).
    var sendDefaultOffered: Bool { snapshot?.sendDefault != nil }

    /// What Send does while a chat works: the Mac's choice with this phone's unconfirmed change over it; Queue when
    /// the Mac says nothing.
    var sendMode: ReplyMode {
        _ = sendDefaultTick
        if let tap = sendDefaultTap, Date().timeIntervalSince(tap.at) < 20 { return tap.mode }
        return snapshot?.sendDefault ?? .queue
    }

    /// Sets the shared default. No Face ID: it is a Mac setting that reaches no chat and carries no words. Shows
    /// the pick at once; on a refusal or a failure puts the old one back and returns the reason.
    func changeSendDefault(_ mode: ReplyMode) async -> String? {
        guard mode != sendMode, !sendDefaultSaving else { return nil }
        sendDefaultTap = (mode, Date())
        sendDefaultSaving = true
        sendDefaultTick += 1
        func fail(_ reason: String) -> String {
            sendDefaultTap = nil
            sendDefaultSaving = false
            sendDefaultTick += 1
            return reason
        }
        if demo {
            snapshot?.sendDefault = mode
            sendDefaultTap = nil
            sendDefaultSaving = false
            sendDefaultTick += 1
            return nil
        }
        guard let channelStore = self.channel else { return fail("Not connected to your Mac.") }
        do {
            let (id, document) = try channelStore.sendDefaultDocument(mode: mode, signer: signer)
            try await channelStore.send(document, id: id)
            guard let result = try await awaitResult(id, on: channelStore) else { return fail("Your Mac didn't answer. Is Squeak running?") }
            guard result.sent else { return fail(result.reason ?? "Your Mac couldn't change that.") }
            await refresh()
            sendDefaultSaving = false
            sendDefaultTick += 1
            return nil
        } catch {
            return fail("Couldn't reach your Mac.")
        }
    }

    /* ---------- new chat presets ---------- */

    /// Preset edits this phone made that the Mac's own view has not shown back yet, oldest first. Each is laid
    /// over the Mac's document for 20 seconds, or until the Mac refuses it.
    private var presetTaps: [(id: UUID, change: PresetsChange, at: Date)] = []
    private var presetTick = 0
    /// Sends go one after another, so the Mac applies edits in the order they were made.
    @ObservationIgnored private var presetSends: Task<Void, Never>?

    /// Whether this Mac sends the shared presets (an older one does not: built-in presets, no editor).
    var presetsOffered: Bool { snapshot?.presets != nil }

    /// The shared presets as shown: the Mac's, with this phone's unconfirmed edits laid over them. Nil from an older Mac.
    var presetsDocument: ChatPresetsDocument? {
        _ = presetTick
        guard var document = snapshot?.presets else { return nil }
        for tap in presetTaps where Date().timeIntervalSince(tap.at) < 20 { tap.change.apply(to: &document) }
        return document
    }

    /// Changes one thing in the shared presets. No Face ID: it is a Mac setting, reaches no chat and carries no
    /// message. Shows the change at once; returns the Mac's reason on a refusal, after putting the old value back.
    func changePresets(_ change: PresetsChange) async -> String? {
        let tap = (id: UUID(), change: change, at: Date())
        presetTaps.append(tap)
        presetTick += 1
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(21))
            self?.presetTaps.removeAll { $0.id == tap.id }
            self?.presetTick += 1
        }
        func fail(_ reason: String) -> String {
            presetTaps.removeAll { $0.id == tap.id }
            presetTick += 1
            return reason
        }
        if demo {
            if var document = snapshot?.presets {
                change.apply(to: &document)
                snapshot?.presets = document
            }
            presetTaps.removeAll { $0.id == tap.id }
            return nil
        }
        let before = presetSends
        let send = Task { @MainActor [weak self] () -> String? in
            await before?.value
            guard let self else { return nil }
            guard let channelStore = self.channel else { return fail("Not connected to your Mac.") }
            do {
                let (id, document) = try channelStore.presetsDocument(change, signer: self.signer)
                try await channelStore.send(document, id: id)
                guard let result = try await self.awaitResult(id, on: channelStore) else { return fail("Your Mac didn't answer. Is Squeak running?") }
                guard result.sent else { return fail(result.reason ?? "Your Mac couldn't change that.") }
                await self.refresh()
                return nil
            } catch {
                return fail("Couldn't reach your Mac.")
            }
        }
        presetSends = Task { _ = await send.value }
        return await send.value
    }

    /* ---------- phone calls ---------- */

    /// Whether this Mac sends phone-call settings (an older one does not, and the page is hidden).
    var voiceOffered: Bool { snapshot?.voice != nil }

    /// Sets the extension to ring (nil clears it) or starts a test call. No Face ID: it is a Mac setting, reaches no
    /// agent and carries no words. Nil when the Mac took it, else a line to show.
    func changeVoice(_ change: VoiceChange) async -> String? {
        if demo {
            switch change {
            case .callee(let value): snapshot?.voice?.callee = value
            case .pin: break
            case .pinAction(let action):
                switch action {
                case .change: snapshot?.voice?.pin = "set"
                case .disable: snapshot?.voice?.pin = "off"
                case .enable: snapshot?.voice?.pin = "set"
                case .reset(let next): snapshot?.voice?.pin = next == nil ? "off" : "set"
                case .policy(let outgoing, let incoming): snapshot?.voice?.policy = .init(outgoing: outgoing, incoming: incoming)
                }
            case .pause(let choice):
                snapshot?.voice?.pause = choice == .resume ? .init(active: false)
                    : .init(active: true, until: choice == .forever ? nil : Date().addingTimeInterval(choice == .hour ? 3600 : 14400).timeIntervalSince1970 * 1000)
            case .natural(let enabled, let voice, let engine, let emotion, let speed):
                if let enabled { snapshot?.voice?.natural?.enabled = enabled }
                if let engine {
                    snapshot?.voice?.natural?.engine = engine
                    if let e = snapshot?.voice?.natural?.engines?.first(where: { $0.id == engine }) {
                        snapshot?.voice?.natural?.voice = e.voice
                        snapshot?.voice?.natural?.voices = e.voices
                    }
                }
                if let emotion { snapshot?.voice?.natural?.emotion = emotion }
                if let speed { snapshot?.voice?.natural?.speed = speed }
                if let voice {
                    snapshot?.voice?.natural?.voice = voice
                    if let i = snapshot?.voice?.natural?.engines?.firstIndex(where: { $0.id == (engine ?? snapshot?.voice?.natural?.engine) }) {
                        snapshot?.voice?.natural?.engines?[i].voice = voice
                    }
                }
            case .favorites(let list):
                snapshot?.voice?.favorites = list.map { f in
                    FavoriteWorkspace(n: f.n, workspace: f.workspace,
                                      label: snapshot?.voice?.workspaces?.first { $0.key == f.workspace }?.label ?? f.label)
                }
            case .test: snapshot?.voice?.lastTest = .init(at: Date().timeIntervalSince1970 * 1000, status: "answered", letter: "A")
            case .hold: break
            case .newChatModel(let pick): snapshot?.voice?.newChatModel = pick
            case .menusByVoice(let on): snapshot?.voice?.menusByVoice = on
            case .offerWaitingChat(let on): snapshot?.voice?.offerWaitingChat = on
            }
            return nil
        }
        guard let channelStore = channel else { return "Not connected to your Mac." }
        do {
            let (id, document) = try channelStore.voiceDocument(change, signer: signer)
            try await channelStore.send(document, id: id)
            guard let result = try await awaitResult(id, on: channelStore) else { return "Your Mac didn't answer. Is Squeak running?" }
            guard result.sent else { return result.reason ?? "Your Mac couldn't change that." }
            await refresh()
            return nil
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    enum SampleAnswer { case audio(Data), refused(String) }

    /// A sample of one realistic voice, made on the Mac and brought over as sealed `media` chunks (the same read path
    /// as a film). No Face ID: it touches no chat and carries no words. Making it takes a few seconds on the Mac.
    func loadVoiceSample(_ voice: String, engine: String? = nil) async -> SampleAnswer {
        if demo { return .refused("Samples play from your Mac, not in the demo.") }
        guard let channel else { return .refused("Not connected to your Mac.") }
        do {
            let (id, document) = try channel.voiceSampleDocument(voice: voice, engine: engine, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel, within: 90) else {
                return .refused("Your Mac didn't answer. Is Squeak running?")
            }
            guard result.sent, let ref = result.media, ref.mime == "audio/wav" else {
                return .refused(result.reason ?? VoiceParityText.sampleFailed)
            }
            return .audio(try await channel.media(ref))
        } catch {
            return .refused(VoiceParityText.sampleFailed)
        }
    }

    /// Asks the Mac to set the Telegram bot's photo to Squeak's logo. No Face ID: a fixed picture, no words.
    /// Returns the line to show: success, or the Mac's reason.
    func setTelegramAvatar() async -> String {
        if demo { try? await Task.sleep(for: .milliseconds(600)); return TelegramAvatarFormat.done }
        guard let channelStore = channel else { return "Not connected to your Mac." }
        do {
            let (id, document) = try channelStore.telegramAvatarDocument(signer: signer)
            try await channelStore.send(document, id: id)
            guard let result = try await awaitResult(id, on: channelStore) else { return TelegramAvatarFormat.noAnswer }
            return TelegramAvatarFormat.line(for: result)
        } catch {
            return TelegramAvatarFormat.unreachable
        }
    }

    /// Whether this Mac sends channel setup (an older one does not, and the page is hidden).
    var channelsSetupOffered: Bool { snapshot?.channelsSetup != nil }

    /// One Telegram setup change. Owner check (Face ID or passcode, always) first unless it is a test or the link
    /// window. A token is only a parameter: it is sealed into the command and kept nowhere else. Nil when the Mac
    /// took it, else a line to show (its own reason; nothing for the quiet while it restarts is an error).
    func changeTelegram(_ change: TelegramChange) async -> String? {
        if change.requiresOwnerCheck, !(await confirmOwner(reason: change.ownerReason)) { return ChannelsSetupFormat.cancelled }
        if demo { applyDemo(change); return nil }
        return await sendSetup { channelStore, signer in try channelStore.telegramDocument(change: change, signer: signer) }
    }

    /// One Cliq setup change; always owner-checked. A webhook is only a parameter, like the token.
    func changeCliq(_ change: CliqChange) async -> String? {
        if !(await confirmOwner(reason: change.ownerReason)) { return ChannelsSetupFormat.cancelled }
        if demo { applyDemo(change); return nil }
        return await sendSetup { channelStore, signer in try channelStore.cliqDocument(change: change, signer: signer) }
    }

    private func sendSetup(
        _ make: (Channel, CommandSigner) throws -> (id: String, document: ChannelDocument)
    ) async -> String? {
        guard let channelStore = channel else { return ChannelsSetupFormat.notConnected }
        do {
            let (id, document) = try make(channelStore, signer)
            try await channelStore.send(document, id: id)
            guard let result = try await awaitResult(id, on: channelStore) else { return ChannelsSetupFormat.noAnswer }
            if let refusal = ChannelsSetupFormat.refusal(for: result) { return refusal }
            await refresh()
            return nil
        } catch {
            return ChannelsSetupFormat.unreachable
        }
    }

    private func applyDemo(_ change: TelegramChange) {
        guard var t = snapshot?.channelsSetup?.telegram else { return }
        switch change {
        case .token: t.tokenSet = true; t.polling = "ok"; t.bot = t.bot ?? "squeak_demo_bot"
        case .off: t.tokenSet = false; t.polling = "off"; t.linking = nil
        case .startLink: t.linking = .init(until: nil, candidates: [.init(id: 4242, name: "Sibhi", type: "private")])
        case .stopLink: t.linking = nil
        case .link(let id):
            let name = t.linking?.candidates.first { $0.id == id }?.name
            t.chats = (t.chats ?? []).filter { $0.id != id } + [.init(id: id, name: name)]
            t.open = false
        case .unlink(let id): t.chats = (t.chats ?? []).filter { $0.id != id }
        case .test: t.lastTest = .init(at: nil, ok: true, sentTo: t.chats?.count ?? 0)
        }
        snapshot?.channelsSetup?.telegram = t
    }

    private func applyDemo(_ change: CliqChange) {
        guard var c = snapshot?.channelsSetup?.cliq else { return }
        switch change {
        case .webhook: c.webhookSet = true; c.oneWay = true
        case .removeWebhook: c.webhookSet = false; c.oneWay = false; c.twoWay = false
        case .owner(let email, let id): c.ownerEmail = email; c.ownerId = id
        }
        snapshot?.channelsSetup?.cliq = c
    }

    /// One live control of the Mac (volume, mute, brightness, fans, screen off). No Face ID: it reaches no agent
    /// and carries no words. Nil when the Mac took it, else a line to show.
    func changeControl(_ change: ControlsCommand.Change) async -> String? {
        if demo {
            // No Mac to ask: the demo keeps what was set.
            guard var controls = snapshot?.macControls else { return nil }
            if let v = change.volume { controls.volume = v }
            if let m = change.muted { controls.muted = m }
            if let b = change.brightness { controls.brightness = b }
            if let f = change.fans { controls.fans?.choice = f; controls.fans?.mode = f }
            if let p = change.power { controls.power?.choice = p; controls.power?.mode = p }
            if let held = change.screenAwake { controls.screenAwake = held }
            snapshot?.macControls = controls
            return nil
        }
        guard let channel else { return "Not connected to your Mac." }
        // A slider's last value goes after the live ones, never beside a stale one still on its way.
        if change.volume != nil || change.brightness != nil {
            livePending = nil
            await sliderTask?.value
        }
        do {
            let (id, document) = try channel.controlsDocument(change, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            guard result.sent else { return result.reason ?? "Your Mac couldn't change that." }
            await refresh()
            return nil
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /// Detailed usage over a range (Usage › Details), asked for when the page opens or the range changes.
    /// The last reading per agent and range, shown at once while a new one is asked for.
    @ObservationIgnored private var usageStatsCache = StaleCache<String, UsageStatsView>(limit: 8)
    func cachedUsageStats(_ range: String, agent: String) -> UsageStatsView? { usageStatsCache.value(for: "\(agent) \(range)") }

    func usageStats(_ range: String, agent: String) async -> (stats: UsageStatsView?, problem: String?) {
        let result = await askUsageStats(range, agent: agent)
        if let stats = result.stats { usageStatsCache.store(stats, for: "\(agent) \(range)") }
        return result
    }

    private func askUsageStats(_ range: String, agent: String) async -> (stats: UsageStatsView?, problem: String?) {
        if demo { return (DemoData.usageStats(range, agent: agent), nil) }
        guard let channel else { return (nil, "Not connected to your Mac.") }
        do {
            let (id, document) = try channel.statsDocument(range: range, agent: agent, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return (nil, "Your Mac didn't answer. Is Squeak running?") }
            guard result.sent, let stats = result.stats else { return (nil, result.reason ?? "Your Mac couldn't read its usage.") }
            return (stats, nil)
        } catch {
            return (nil, "Couldn't reach your Mac.")
        }
    }

    /// The Mac's installed apps for the app picker, asked for when it opens; the reason when they could not be.
    /// Mac apps' icons, by bundle id: asked for once each and kept on this phone (they don't change).
    private(set) var appIcons: [String: UIImage] = [:]
    @ObservationIgnored private var iconsAsked: Set<String> = []

    private static var iconFolder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mac-app-icons", isDirectory: true)
    }

    /// Loads what this phone already has, then asks the Mac for the rest.
    func loadAppIcons(_ ids: [String]) async {
        let wanted = ids.filter { appIcons[$0] == nil && !iconsAsked.contains($0) }
        // Disk reads and decoding off the main thread.
        let folder = Self.iconFolder
        let found = await Task.detached(priority: .userInitiated) { () -> [String: UIImage] in
            var out: [String: UIImage] = [:]
            for id in wanted {
                if let data = try? Data(contentsOf: folder.appendingPathComponent("\(id).png")), let image = UIImage(data: data) { out[id] = image }
            }
            return out
        }.value
        var missing: [String] = []
        for id in wanted { if let image = found[id] { appIcons[id] = image } else { missing.append(id) } }
        guard !missing.isEmpty, !demo, let channel else { return }
        iconsAsked.formUnion(missing)
        do {
            let (id, document) = try channel.controlsDocument(.appIcons(missing), signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel, quiet: true), result.sent, let icons = result.icons else { return }
            try? FileManager.default.createDirectory(at: Self.iconFolder, withIntermediateDirectories: true)
            for (app, base64) in icons {
                guard let data = Data(base64Encoded: base64), let image = UIImage(data: data) else { continue }
                appIcons[app] = image
                try? data.write(to: Self.iconFolder.appendingPathComponent("\(app).png"))
            }
        } catch {
            iconsAsked.subtract(missing)
        }
    }

    /// The front app's tabs, read, or changed (a tab pressed, a Conductor chat opened) and read again.
    func frontTabs(_ change: ControlsCommand.Change = .listTabs) async -> (tabs: FrontTabs?, problem: String?) {
        let result = await askFrontTabs(change)
        if let tabs = result.tabs, let app = tabs.app?.id { frontTabsCache.store(tabs, for: app) }
        return result
    }

    /// The last tabs read per app, so the card shows them at once when an app comes to the front again.
    @ObservationIgnored private var frontTabsCache = StaleCache<String, FrontTabs>(limit: 12)
    func cachedTabs(for appId: String) -> FrontTabs? { frontTabsCache.value(for: appId) }
    func tabsAreFresh(for appId: String, ttl: TimeInterval = 10) -> Bool { frontTabsCache.isFresh(appId, ttl: ttl) }

    private func askFrontTabs(_ change: ControlsCommand.Change) async -> (tabs: FrontTabs?, problem: String?) {
        if demo { return (DemoData.frontTabs, nil) }
        guard let channel else { return (nil, "Not connected to your Mac.") }
        do {
            let (id, document) = try channel.controlsDocument(change, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return (nil, "Your Mac didn't answer. Is Squeak running?") }
            guard result.sent else { return (nil, result.reason ?? "Your Mac couldn't do that.") }
            return (result.tabs, nil)
        } catch {
            return (nil, "Couldn't reach your Mac.")
        }
    }

    private static var appListFile: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mac-app-list.json")
    }
    @ObservationIgnored private var installedAppsMemory: [PhoneSnapshot.MacApp]?

    /// The last list of the Mac's apps, from memory or the small file in Caches; nil when there never was one.
    func cachedInstalledApps() -> [PhoneSnapshot.MacApp]? {
        if let installedAppsMemory { return installedAppsMemory }
        installedAppsMemory = AppListFile.load(from: Self.appListFile)
        return installedAppsMemory
    }

    func installedApps() async -> (apps: [PhoneSnapshot.MacApp], problem: String?) {
        let result = await askInstalledApps()
        if result.problem == nil, !result.apps.isEmpty, !demo {
            installedAppsMemory = result.apps
            let apps = result.apps, file = Self.appListFile
            Task.detached(priority: .utility) { AppListFile.save(apps, to: file) }
        }
        return result
    }

    private func askInstalledApps() async -> (apps: [PhoneSnapshot.MacApp], problem: String?) {
        if demo { return (DemoData.installedApps, nil) }
        guard let channel else { return ([], "Not connected to your Mac.") }
        do {
            let (id, document) = try channel.controlsDocument(.listApps, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return ([], "Your Mac didn't answer. Is Squeak running?") }
            guard result.sent else { return ([], result.reason ?? "Your Mac couldn't list its apps.") }
            return (result.apps ?? [], nil)
        } catch {
            return ([], "Couldn't reach your Mac.")
        }
    }

    @ObservationIgnored private var liveSending = false
    @ObservationIgnored private var livePending: ControlsCommand.Change?
    @ObservationIgnored private var sliderTask: Task<Void, Never>?

    /// Whether a slider can move the Mac as it moves: only on the direct same-Wi-Fi path, where a command is
    /// one local request. Through the cloud each one is a database round trip, so it waits for the release.
    var controlsLive: Bool { route == .local && !demo }

    /// A slider moving on the direct path: the newest value only, one command at a time, without waiting for
    /// the Mac's answer (the release still sends through `changeControl`, which does).
    func changeControlLive(_ change: ControlsCommand.Change) {
        guard controlsLive, let channel else { return }
        if liveSending { livePending = change; return }
        liveSending = true
        let signer = signer
        sliderTask = Task { [weak self] in
            var next: ControlsCommand.Change? = change
            while let current = next {
                if let (id, document) = try? channel.controlsDocument(current, signer: signer) {
                    try? await channel.send(document, id: id)
                }
                try? await Task.sleep(for: .milliseconds(150))
                next = self?.livePending
                self?.livePending = nil
            }
            self?.liveSending = false
        }
    }

    /// Switches the Claude account new chats use on the Mac. Face ID first, like a send: it changes whose
    /// plan every new chat spends. Nil when it worked, else a line to show.
    func switchClaudeAccount(_ name: String) async -> String? {
        if demo {
            try? await Task.sleep(for: .milliseconds(500))
            if let list = snapshot?.claudeAccounts {
                snapshot?.claudeAccounts = ClaudeAccounts(available: list.available, current: name, accounts: list.accounts)
            }
            return nil
        }
        guard await confirmWithBiometrics(reason: "Switch Claude to \(name)") else { return "Face ID was cancelled." }
        guard let channel else { return "Not connected to your Mac." }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.claudeAccountDocument(use: name, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            guard result.sent else { return result.reason ?? "Your Mac couldn't switch." }
            await refresh()
            return nil
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    enum HotspotChange { case configure(ssid: String, password: String?, enabled: Bool), join, leave }

    /// Sets up hotspot failover, or switches the Mac's network now. Face ID first: it changes how the
    /// Mac reaches the internet, and a setup carries a password. Nil when it worked, else a line to show.
    func changeHotspot(_ change: HotspotChange) async -> String? {
        if demo { try? await Task.sleep(for: .milliseconds(500)); return nil }
        guard await confirmWithBiometrics(reason: "Change your Mac's network") else { return "Face ID was cancelled." }
        guard let channel else { return "Not connected to your Mac." }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) { () -> (String, ChannelDocument) in
                switch change {
                case let .configure(ssid, password, enabled):
                    return try channel.hotspotDocument(action: .configure, ssid: ssid, password: password, enabled: enabled, signer: signer)
                case .join: return try channel.hotspotDocument(action: .join, signer: signer)
                case .leave: return try channel.hotspotDocument(action: .leave, signer: signer)
                }
            }.value
            try await channel.send(document, id: id)
            // Joining a network takes the Mac up to half a minute; it answers once it has.
            guard let result = try await awaitResult(id, on: channel) else {
                return "Your Mac didn't answer. If it switched networks, it reconnects in a moment."
            }
            return result.sent ? nil : (result.reason ?? "Your Mac couldn't change that.")
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /// Starts, extends or ends the Mac's awake session. No Face ID: it reaches no agent.
    /// Returns a line for the screen on failure.
    func changeAwake(_ change: AwakeChange) async -> String? {
        let expected: AwakeStatus?
        switch change {
        case .start(let minutes, let lid):
            expected = AwakeStatus(until: minutes.map { Date().addingTimeInterval(Double($0) * 60) }, lid: lid ? "starting" : nil,
                                   pending: true)
        case .extend(let minutes):
            expected = AwakeStatus(
                until: awake?.until.map { max($0, Date()).addingTimeInterval(Double(minutes) * 60) }, lid: awake?.lid)
        case .end: expected = nil
        }
        awakeTapped = (change, expected, Date())
        expireAwakeTap()
        if demo { return nil }
        guard let channel else { awakeTapped = nil; return "Not connected to your Mac." }
        do {
            let (id, document): (String, ChannelDocument)
            switch change {
            case .start(let minutes, let lid):
                (id, document) = try channel.awakeDocument(on: true, minutes: minutes, lid: lid ? true : nil, signer: signer)
            case .extend(let minutes): (id, document) = try channel.awakeDocument(on: true, extend: minutes, signer: signer)
            case .end: (id, document) = try channel.awakeDocument(on: false, signer: signer)
            }
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                awakeTapped = nil
                return "Your Mac didn't answer. Is Squeak running?"
            }
            guard result.sent else { awakeTapped = nil; return result.reason ?? "Your Mac couldn't change that." }
            // The Mac has acted: read what it now says rather than wait for the next push.
            await refresh()
            return nil
        } catch {
            awakeTapped = nil
            return "Couldn't reach your Mac."
        }
    }

    /// Any send of this session still waiting on the Mac.
    func isSending(_ key: String) -> Bool { outbox[key]?.contains { $0.status == .sending } ?? false }

    private func begin(_ text: String, for session: PhoneSnapshot.Session, mode: ReplyMode) -> UUID {
        let send = ChatSend(
            text: text, date: Date(), answersTurn: session.turnId ?? remembered[session.key]?.turnId, status: .sending,
            mode: mode, queuedBehindTurn: mode == .queue && session.state == "working")
        outbox[session.key, default: []].append(send)
        // On disk before anything else happens: an app killed mid-send must not lose what was typed.
        persistOutbox()
        return send.id
    }

    /* ---------- images ---------- */

    enum ImageAnswer: Sendable { case image(UIImage), refused(String) }

    @ObservationIgnored private let imageFlight = InFlight<ImageAnswer>()
    @ObservationIgnored private let imageLimiter = ConcurrencyLimiter(limit: 3)

    /// Images already fetched this run, by chat and source: memory only, newest 64 and at most ~60 MB decoded.
    @ObservationIgnored private var images: [String: UIImage] = [:]
    @ObservationIgnored private var imageOrder: [String] = []
    @ObservationIgnored private var imageBytes = 0
    private static func cost(_ image: UIImage) -> Int {
        Int(image.size.width * image.scale * image.size.height * image.scale * 4)
    }

    /// Demo pictures with a known shape (`-portrait` tall, `-wide` landscape), to see how a chat keeps it.
    private static func demoPicture(_ source: String) -> UIImage? {
        let size: CGSize
        if source.contains("-portrait") { size = CGSize(width: 600, height: 1300) }
        else if source.contains("-wide") { size = CGSize(width: 1600, height: 700) }
        else if source.hasPrefix("demo/") { size = CGSize(width: 960, height: 540) }
        else { return nil }
        // A film's demo pictures: a soft gradient of its own colours, named, so a grid of them tells apart.
        if source.hasPrefix("demo/") {
            let name = (source as NSString).lastPathComponent.replacingOccurrences(of: ".png", with: "")
            let seed = name.unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) % 360 }
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
                let a = UIColor(hue: CGFloat(seed) / 360, saturation: 0.45, brightness: 0.75, alpha: 1).cgColor
                let b = UIColor(hue: CGFloat((seed + 40) % 360) / 360, saturation: 0.55, brightness: 0.35, alpha: 1).cgColor
                let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [a, b] as CFArray, locations: [0, 1])!
                ctx.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
                let label = name as NSString
                let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 54, weight: .semibold), .foregroundColor: UIColor.white.withAlphaComponent(0.9)]
                let textSize = label.size(withAttributes: attrs)
                label.draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2), withAttributes: attrs)
            }
        }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let colors = [UIColor(red: 0.98, green: 0.78, blue: 0.2, alpha: 1).cgColor, UIColor(red: 0.2, green: 0.45, blue: 0.9, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            ctx.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            let label = "\(Int(size.width)) × \(Int(size.height))" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: size.width / 9), .foregroundColor: UIColor.white]
            let textSize = label.size(withAttributes: attrs)
            label.draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2), withAttributes: attrs)
        }
    }

    /// An image the chat's agent showed, from the Mac (read-only, so no Face ID). Kept in memory
    /// only, never written to the phone.
    func loadImage(_ session: PhoneSnapshot.Session, source: String) async -> ImageAnswer {
        // A picture on a film's card is named by the session's key; a chat's, by its Conductor id.
        let cardKey = session.workflow != nil ? session.key : nil
        return await fetchImage(
            cacheKey: session.key + "\u{1}" + source, source: source,
            sessionId: session.conductorSessionId ?? (cardKey == nil ? nil : ""), sessionKey: cardKey, filmId: nil)
    }

    /// A picture on a card, whichever it belongs to: a chat's film card (named by the session's key) or a film
    /// of its own (named by the film's id).
    func loadImage(_ owner: WorkflowOwner, source: String) async -> ImageAnswer {
        switch owner {
        case let .session(session): return await loadImage(session, source: source)
        case let .film(film): return await loadImage(film: film, source: source)
        }
    }

    /// A film's own picture (poster, a call's images), by the film's id: no session at all.
    func loadImage(film: PhoneFilm, source: String) async -> ImageAnswer {
        await fetchImage(cacheKey: film.id + "\u{1}" + source, source: source, sessionId: "", sessionKey: nil, filmId: film.id)
    }

    private func fetchImage(cacheKey: String, source: String, sessionId: String?, sessionKey: String?, filmId: String?) async -> ImageAnswer {
        if let hit = images[cacheKey] { return .image(hit) }
        if demo {
            try? await Task.sleep(for: .milliseconds(400))
            if let shaped = Self.demoPicture(source) { return .image(shaped) }
            return UIImage(named: "duck-asleep", in: .module, with: nil).map(ImageAnswer.image) ?? .refused("No demo image.")
        }
        // The same picture asked for twice at once (a grid cell and the viewer) is one request, and at most three go out.
        return await imageFlight.value(for: cacheKey) { [self] in
            await imageLimiter.run {
                await networkImage(cacheKey: cacheKey, source: source, sessionId: sessionId, sessionKey: sessionKey, filmId: filmId)
            }
        }
    }

    private func remember(_ cacheKey: String, _ image: UIImage) {
        if let old = images[cacheKey] { imageBytes -= Self.cost(old) }
        images[cacheKey] = image
        imageBytes += Self.cost(image)
        imageOrder.removeAll { $0 == cacheKey }
        imageOrder.append(cacheKey)
        while imageOrder.count > 1, imageOrder.count > 64 || imageBytes > 60_000_000 {
            let gone = imageOrder.removeFirst()
            if let old = images.removeValue(forKey: gone) { imageBytes -= Self.cost(old) }
        }
    }

    private func networkImage(cacheKey: String, source: String, sessionId: String?, sessionKey: String?, filmId: String?) async -> ImageAnswer {
        if let hit = images[cacheKey] { return .image(hit) }
        guard let channel, let sessionId else { return .refused("Not connected to your Mac.") }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.imageDocument(sessionId: sessionId, sessionKey: sessionKey, filmId: filmId, source: source, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return .refused("Your Mac didn't answer. Is Squeak running?") }
            guard result.sent, let image = result.image else { return .refused(result.reason ?? "Your Mac couldn't send that image.") }
            let decoded = await Task.detached { () -> UIImage? in
                guard let data = Data(base64Encoded: image.data), let ui = UIImage(data: data) else { return nil }
                return await ui.byPreparingForDisplay() ?? ui
            }.value
            guard let decoded else { return .refused("That image arrived damaged.") }
            remember(cacheKey, decoded)
            return .image(decoded)
        } catch {
            return .refused("Couldn't reach your Mac.")
        }
    }

    /* ---------- a film's media ---------- */

    enum MediaAnswer { case file(URL), refused(String) }

    /// What a film's card plays, as a phone copy: the Mac converts it and leaves it in the channel in
    /// sealed chunks; this fetches them, checks the hash, and keeps the file in Caches by its hash.
    /// Read-only, so no Face ID. Converting and uploading take a while on a slow link (5 MB took ~110 s at 50 KB/s), so this waits up to 5 minutes.
    func loadMedia(_ owner: WorkflowOwner, source: String, progress: (@Sendable (Double) -> Void)? = nil) async -> MediaAnswer {
        if demo { return .refused("Films play from your Mac, not in the demo.") }
        guard let channel else { return .refused("Not connected to your Mac.") }
        do {
            let signer = signer
            let (sessionKey, filmId): (String?, String?) = switch owner {
            case let .session(session): (session.key, nil)
            case let .film(film): (nil, film.id)
            }
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.mediaDocument(sessionKey: sessionKey, filmId: filmId, source: source, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel, within: 300) else {
                return .refused("Your Mac didn't answer. Is Squeak running?")
            }
            guard result.sent, let ref = result.media else { return .refused(result.reason ?? "Your Mac couldn't send that.") }
            let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("squeak-media", isDirectory: true)
            let file = folder.appendingPathComponent(String(ref.sha256.prefix(32)) + (ref.mime.hasPrefix("video") ? ".m4v" : ".m4a"))
            if FileManager.default.fileExists(atPath: file.path) { return .file(file) }
            let data = try await channel.media(ref) { done, total in progress?(Double(done) / Double(max(total, 1))) }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            return .file(file)
        } catch is CancellationError {
            return .refused("Cancelled.")
        } catch {
            return .refused("Couldn't bring it over from your Mac. Try again.")
        }
    }

    /* ---------- what changed ---------- */

    enum DiffAnswer { case diff(WorkspaceDiff, FilePatch?), refused(String) }

    /// What a chat changed, from the Mac (read-only, so no Face ID): the file list, and one file's
    /// patch when `file` is its index in that list.
    /// The file list and each file's patch are kept per chat for `diffTTL` (the result carries no revision):
    /// a cached one shows at once (`cachedDiff`, `cachedPatch`) and `loadDiff` reads again behind it.
    @ObservationIgnored private var diffCache = StaleCache<String, WorkspaceDiff>(limit: 8)
    @ObservationIgnored private var patchCache = StaleCache<String, FilePatch>(limit: 24)
    static let diffTTL: TimeInterval = 30

    func cachedDiff(_ session: PhoneSnapshot.Session) -> (diff: WorkspaceDiff, fresh: Bool)? {
        guard let id = session.conductorSessionId, let diff = diffCache.value(for: id) else { return nil }
        return (diff, diffCache.isFresh(id, ttl: Self.diffTTL))
    }

    func cachedPatch(_ session: PhoneSnapshot.Session, path: String) -> (patch: FilePatch, fresh: Bool)? {
        guard let id = session.conductorSessionId, let patch = patchCache.value(for: "\(id)#\(path)") else { return nil }
        return (patch, patchCache.isFresh("\(id)#\(path)", ttl: Self.diffTTL))
    }

    func loadDiff(_ session: PhoneSnapshot.Session, file: Int? = nil) async -> DiffAnswer {
        let answer = await askDiff(session, file: file)
        if case let .diff(diff, patch) = answer, let id = session.conductorSessionId {
            diffCache.store(diff, for: id)
            if let patch { patchCache.store(patch, for: "\(id)#\(patch.path)") }
        }
        return answer
    }

    private func askDiff(_ session: PhoneSnapshot.Session, file: Int?) async -> DiffAnswer {
        if demo {
            try? await Task.sleep(for: .milliseconds(300))
            return .diff(DemoData.diff, file.map { DemoData.patch(for: $0) })
        }
        guard let channel, let sessionId = session.conductorSessionId else { return .refused("Not connected to your Mac.") }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.diffDocument(sessionId: sessionId, file: file, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return .refused("Your Mac didn't answer. Is Squeak running?") }
            guard result.sent, let diff = result.diff else { return .refused(result.reason ?? "Your Mac couldn't read the changes.") }
            return .diff(diff, result.patch)
        } catch {
            return .refused("Couldn't reach your Mac.")
        }
    }

    /* ---------- the work between two messages ---------- */

    enum WorkAnswer { case steps(WorkSteps), refused(String) }

    /// Steps already read from the Mac, by chat and message: a row opened once is not asked for again this session.
    private(set) var workCache: [String: WorkSteps] = [:]

    func workSteps(for session: PhoneSnapshot.Session, messageId: String) -> WorkSteps? {
        workCache["\(session.key)|\(messageId)"]
    }

    /// The steps behind a "Worked" row, read from the Mac when the row is opened (read-only, so no Face ID).
    func loadWork(_ session: PhoneSnapshot.Session, messageId: String) async -> WorkAnswer {
        let cacheKey = "\(session.key)|\(messageId)"
        if let cached = workCache[cacheKey] { return .steps(cached) }
        if demo {
            try? await Task.sleep(for: .milliseconds(300))
            let steps = WorkSteps(steps: [.init(kind: "tool", text: "Read radar.ts"), .init(kind: "tool", text: "Edit radar.ts"), .init(kind: "tool", text: "Run tests")], more: 0)
            workCache[cacheKey] = steps
            return .steps(steps)
        }
        guard let channel, let sessionId = session.conductorSessionId else { return .refused("Not connected to your Mac.") }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.workDocument(sessionId: sessionId, messageId: messageId, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return .refused("Your Mac didn't answer. Is Squeak running?") }
            guard result.sent, let work = result.work else { return .refused(result.reason ?? "Your Mac couldn't read those steps.") }
            workCache[cacheKey] = work
            return .steps(work)
        } catch {
            return .refused("Couldn't reach your Mac.")
        }
    }

    /* ---------- stop ---------- */

    /// Chats a Stop was sent to, until the Mac stops calling them working (or 30 s pass).
    private(set) var stopping: [String: Date] = [:]

    func isStopping(_ key: String) -> Bool {
        guard let at = stopping[key] else { return false }
        return Date().timeIntervalSince(at) < 30 && snapshot?.session(key)?.state == "working"
    }

    /// Stop the agent's turn, as Conductor's Stop button does. The working row says
    /// "Stopping…" at once; nil when the Mac did it, else why not.
    @discardableResult
    func stop(_ session: PhoneSnapshot.Session) async -> String? {
        stopping[session.key] = Date()
        Haptics.play(.stop)
        let refusal = await stopCommand(session)
        if let refusal {
            stopping[session.key] = nil
            problemFor[session.key] = refusal
            Haptics.play(.refused)
        } else {
            problemFor[session.key] = nil
        }
        return refusal
    }

    /// A model change the Mac took that its next view has not shown yet: the chat's setup line shows this meanwhile.
    private(set) var setupPending: [String: (line: String, at: Date)] = [:]

    func pendingSetupLine(_ session: PhoneSnapshot.Session) -> String? {
        guard let pending = setupPending[session.key], Date().timeIntervalSince(pending.at) < 15 else { return nil }
        return pending.line
    }

    /// The models this chat can switch to: the Mac's list for the chat's own agent, so never another provider's.
    /// Empty when the Mac cannot change a chat's model (it sends `modelId` only when it can).
    func setupModels(for session: PhoneSnapshot.Session) -> [PhoneSnapshot.ChatModel] {
        guard session.modelId != nil, session.conductorSessionId != nil else { return [] }
        return (snapshot?.chatModels ?? []).filter { $0.agent == session.agent }
    }

    /// Changes what a chat runs, as Conductor's own picker does. Nil when the Mac did it, else why not.
    @discardableResult
    func changeSetup(_ session: PhoneSnapshot.Session, model chosen: PhoneSnapshot.ChatModel, thinking: String?, fast: Bool?) async -> String? {
        let level = thinking ?? (session.effortId.flatMap { chosen.levels.contains($0) ? $0 : nil }) ?? chosen.defaultLevel
        let line = [chosen.label, level.map { (name: String) -> String in let words = ChatPresets.levelName(name); return words.prefix(1).uppercased() + words.dropFirst() }, (fast ?? session.fast) == true ? "Fast" : nil]
            .compactMap { $0 }.joined(separator: " · ")
        Haptics.play(.pick)
        // The new setup is on the line at the tap; a refusal puts the old one back.
        let before = setupPending[session.key]
        setupPending[session.key] = (line, Date())
        if demo {
            try? await Task.sleep(for: .milliseconds(400))
            return nil
        }
        guard let channel else { setupPending[session.key] = before; return "Not connected to your Mac." }
        let refusal: String?
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.setupDocument(to: session, model: chosen.id, thinking: thinking, fast: fast, signer: signer)
            }.value
            try await channel.send(document, id: id)
            if let result = try await awaitResult(id, on: channel) {
                refusal = result.sent ? nil : (result.reason ?? "Your Mac refused that.")
            } else {
                refusal = "Your Mac didn't answer. Is Squeak running?"
            }
        } catch {
            refusal = "Couldn't reach your Mac."
        }
        if let refusal {
            setupPending[session.key] = before
            problemFor[session.key] = refusal
            Haptics.play(.refused)
        } else {
            problemFor[session.key] = nil
            setupPending[session.key] = (line, Date())
        }
        return refusal
    }

    /// A chat's menu action the Mac has not answered yet ("Opening a pull request…"), by chat key. The chat shows it
    /// where its other control feedback goes (under the composer) with a spinner, and a second tap on any of these
    /// actions is ignored until the first ends. Menu items cannot show a spinner, so the screen they act on does.
    private(set) var inFlight: [String: String] = [:]

    private func tracking(_ session: PhoneSnapshot.Session, _ line: String, _ work: () async -> String?) async -> String? {
        guard inFlight[session.key] == nil else { return nil }
        inFlight[session.key] = line
        defer { inFlight[session.key] = nil }
        return await work()
    }

    /// The chat whose name is being edited: set by a row's menu or the chat's header, read by the one alert at the root.
    var renameTarget: PhoneSnapshot.Session?

    /// Gives a chat a new name, in Conductor too. Nil when the Mac did it, else why not. The new name
    /// shows once the Mac's next view carries it, a second or two later.
    func rename(_ session: PhoneSnapshot.Session, to title: String) async -> String? {
        await tracking(session, "Renaming…") { await renameNow(session, to: title) }
    }

    private func renameNow(_ session: PhoneSnapshot.Session, to title: String) async -> String? {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= RenameCommand.maxLength else { return "A name is 1 to \(RenameCommand.maxLength) characters." }
        if demo { try? await Task.sleep(for: .milliseconds(400)); return nil }
        guard session.conductorSessionId != nil else { return "Only a Conductor chat can be renamed." }
        guard await confirmWithBiometrics(reason: "Rename \(session.label)") else { return "Face ID was cancelled." }
        guard let channel else { return "Not connected to your Mac." }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.renameDocument(to: session, title: name, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            return result.sent ? nil : (result.reason ?? "Your Mac refused that.")
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /// The chat the close sheet is asking about: set by a row's menu or the chat's header, read by the one dialog at the root.
    var closeTarget: PhoneSnapshot.Session?

    /// Closes the chat's tab in Conductor, as closing it there does (the chat and its history stay). Nil when the Mac
    /// did it, else why not. It shows as closed once the Mac's next view says so.
    func closeInConductor(_ session: PhoneSnapshot.Session) async -> String? {
        await tracking(session, "Closing in Conductor…") { await closeNow(session) }
    }

    private func closeNow(_ session: PhoneSnapshot.Session) async -> String? {
        if demo { try? await Task.sleep(for: .milliseconds(400)); return nil }
        guard session.conductorSessionId != nil else { return "Only a Conductor chat can be closed." }
        guard await confirmWithBiometrics(reason: "Close \(session.label)") else { return "Face ID was cancelled." }
        guard let channel else { return "Not connected to your Mac." }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.closeDocument(to: session, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            if result.sent { await refresh() }
            return result.sent ? nil : (result.reason ?? "Your Mac refused that.")
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /* ---------- workspaces ---------- */

    /// Whether this Mac archives and makes workspaces and asks chats for PRs (it lists repositories when it does).
    var workspaceActions: Bool { snapshot?.repos != nil || demo }

    /// The chat whose workspace the archive dialog is asking about: set by the chat's menu, read at the root.
    var archiveTarget: PhoneSnapshot.Session?

    private func workspaceCommand(action: String, workspaceId: String? = nil, repoId: String? = nil,
                                  session: PhoneSnapshot.Session? = nil) async -> (CommandResult?, String?) {
        guard let channel else { return (nil, "Not connected to your Mac.") }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.workspaceDocument(action: action, workspaceId: workspaceId, repoId: repoId, session: session, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel, within: 45) else { return (nil, "Your Mac didn't answer. Is Squeak running?") }
            return result.sent ? (result, nil) : (nil, result.reason ?? "Your Mac refused that.")
        } catch {
            return (nil, "Couldn't reach your Mac.")
        }
    }

    /// Archives the chat's workspace in Conductor (its chats stop; the branch stays). Nil when the Mac did it.
    func archiveWorkspace(of session: PhoneSnapshot.Session) async -> String? {
        await tracking(session, "Archiving workspace…") { await archiveNow(of: session) }
    }

    private func archiveNow(of session: PhoneSnapshot.Session) async -> String? {
        if demo { try? await Task.sleep(for: .milliseconds(400)); return nil }
        guard let workspaceId = session.workspaceId else { return "Only a Conductor chat's workspace can be archived." }
        let place = Presentation.split(label: session.label).repo ?? session.label
        guard await confirmWithBiometrics(reason: "Archive the \(place) workspace") else { return "Face ID was cancelled." }
        let (_, problem) = await workspaceCommand(action: "archive", workspaceId: workspaceId)
        if problem == nil {
            Haptics.play(.confirmed)
            await refresh()
        }
        return problem
    }

    /// Makes a workspace in a repository, branched from its default branch. Its id, or why not.
    func createWorkspace(in repo: PhoneSnapshot.Repo) async -> (id: String?, problem: String?) {
        if demo { try? await Task.sleep(for: .milliseconds(600)); return (nil, "Demo: no workspace is made.") }
        let (result, problem) = await workspaceCommand(action: "create", repoId: repo.id)
        if result != nil { await refresh() }
        return (result?.workspaceId, problem)
    }

    /// Asks a resting chat to open a pull request (commit, push, `gh pr create` onto its target branch).
    @discardableResult
    func askForPullRequest(_ session: PhoneSnapshot.Session) async -> String? {
        await tracking(session, "Opening a pull request…") { await pullRequestNow(session) }
    }

    private func pullRequestNow(_ session: PhoneSnapshot.Session) async -> String? {
        Haptics.play(.tap)
        if demo { try? await Task.sleep(for: .milliseconds(400)); return nil }
        let (_, problem) = await workspaceCommand(action: "createPr", session: session)
        if let problem {
            problemFor[session.key] = problem
            Haptics.play(.refused)
        } else {
            problemFor[session.key] = nil
            Haptics.play(.confirmed)
        }
        return problem
    }

    /* ---------- hidden on this phone ---------- */

    /// Chats put away on this phone only, by when (seconds since 1970). The Mac and Conductor are untouched; a chat
    /// comes back by itself when it has newer activity. Kept across launches.
    private(set) var hiddenHere: [String: Double] = UserDefaults.standard.dictionary(forKey: "squeak.hiddenHere") as? [String: Double] ?? [:] {
        didSet { UserDefaults.standard.set(hiddenHere, forKey: "squeak.hiddenHere") }
    }

    func isHiddenHere(_ session: PhoneSnapshot.Session) -> Bool {
        HomeLists.isHidden(session, hidden: hiddenHere)
    }

    func hideHere(_ session: PhoneSnapshot.Session) { hiddenHere[session.key] = Date().timeIntervalSince1970 }
    func showHiddenAgain() { hiddenHere = [:] }

    /// The last thing that went wrong with a chat's control (a Stop), shown under its composer.
    private(set) var problemFor: [String: String] = [:]

    private func stopCommand(_ session: PhoneSnapshot.Session) async -> String? {
        if demo { try? await Task.sleep(for: .milliseconds(500)); return nil }
        guard await confirmWithBiometrics(reason: "Stop \(session.label)") else { return "Face ID was cancelled." }
        guard let channel else { return "Not connected to your Mac." }
        do {
            let signer = signer
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.stopDocument(to: session, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            return result.sent ? nil : (result.reason ?? "Your Mac refused that.")
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /* ---------- the queue ---------- */

    /// Cards taken off the queue on a tap, before the Mac's queue says so; given back if it refuses.
    private(set) var hiddenQueued: Set<String> = []

    /// What a queue card's tap did, for the card's one line when it did not work.
    private(set) var queueProblem: [String: String] = [:]

    /// Marks this phone's queued sends the Mac's queue has shown, so their leaving it reads as sent.
    private func noteQueue(_ turn: LiveTurn?, for key: String) {
        guard let ids = turn?.queue.map({ Set($0.map(\.id)) }), var sends = outbox[key] else { return }
        var changed = false
        for i in sends.indices where !sends[i].seenInQueue && ids.contains(sends[i].messageId) {
            sends[i].seenInQueue = true; changed = true
            // Conductor's own queue has it: an unconfirmed send did arrive.
            if case .notConfirmed = sends[i].status {
                sends[i].status = .queued(agent: session(key).map { Presentation.agentName($0.agent) } ?? "The agent", steerUnavailable: false)
            }
        }
        // Once the Mac stops listing it, it went to the agent: its bubble says sent.
        for i in sends.indices where sends[i].seenInQueue && !ids.contains(sends[i].messageId) {
            if case .queued = sends[i].status { sends[i].status = .sent; changed = true }
        }
        if changed { outbox[key] = sends; persistOutbox() }
        hiddenQueued.formIntersection(ids)
    }

    /// Steer a queued message into the turn now. It leaves the stack at once and shows in the turn
    /// as steered; if the Mac refuses, it comes back with the reason.
    func steerQueued(_ card: ChatQueue.Card, in session: PhoneSnapshot.Session) async {
        let local = outbox[session.key]?.firstIndex { $0.messageId == card.id }
        hiddenQueued.insert(card.id)
        queueProblem[card.id] = nil
        // Shown in the turn straight away, where a steer goes.
        let steerId: UUID
        if let local, var send = outbox[session.key]?[local] {
            outbox[session.key]?.remove(at: local)
            send = ChatSend(id: send.id, text: send.text, date: Date(), answersTurn: send.answersTurn, status: .sending,
                            messageId: send.messageId, mode: .steer)
            outbox[session.key, default: []].append(send)
            steerId = send.id
        } else {
            let send = ChatSend(text: card.text, date: Date(), answersTurn: session.turnId, status: .sending, messageId: card.id, mode: .steer)
            outbox[session.key, default: []].append(send)
            steerId = send.id
        }
        Haptics.play(.steer)
        let refusal = await queueCommand(.promote, card: card, session: session)
        if let refusal {
            outbox[session.key]?.removeAll { $0.id == steerId }
            persistOutbox()
            hiddenQueued.remove(card.id)
            queueProblem[card.id] = refusal
            Haptics.play(.refused)
        } else {
            finish(steerId, .steered, for: session)
        }
    }

    /// Take a queued message out of the queue. Returns its text when it was removed, for Edit.
    @discardableResult
    func removeQueued(_ card: ChatQueue.Card, in session: PhoneSnapshot.Session) async -> String? {
        hiddenQueued.insert(card.id)
        queueProblem[card.id] = nil
        let refusal = await queueCommand(.cancel, card: card, session: session)
        if let refusal {
            hiddenQueued.remove(card.id)
            queueProblem[card.id] = refusal
            Haptics.play(.refused)
            return nil
        }
        outbox[session.key]?.removeAll { $0.messageId == card.id }
        persistOutbox()
        return card.text
    }

    /// nil when the Mac did it; otherwise why not.
    private func queueCommand(_ action: QueueCommand.Action, card: ChatQueue.Card, session: PhoneSnapshot.Session) async -> String? {
        if demo { try? await Task.sleep(for: .milliseconds(400)); return nil }
        guard await confirmWithBiometrics(reason: action == .promote ? "Steer into \(session.label)" : "Remove from the queue") else {
            return "Face ID was cancelled."
        }
        guard let channel, let sessionId = session.conductorSessionId else { return "Not connected to your Mac." }
        do {
            let signer = signer, messageId = card.id
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.queueDocument(sessionId: sessionId, messageId: messageId, action: action, signer: signer)
            }.value
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else { return "Your Mac didn't answer. Is Squeak running?" }
            return result.sent ? nil : (result.reason ?? "Your Mac refused that.")
        } catch {
            return "Couldn't reach your Mac."
        }
    }

    /// A send that never left the phone (Face ID declined): gone from the chat, its text back in the field.
    private func withdraw(_ id: UUID, for session: PhoneSnapshot.Session) {
        outbox[session.key]?.removeAll { $0.id == id }
        persistOutbox()
    }

    private func finish(_ id: UUID, _ status: ChatSend.Status, for session: PhoneSnapshot.Session) {
        guard let i = outbox[session.key]?.firstIndex(where: { $0.id == id }) else { return }
        outbox[session.key]?[i].status = status
        persistOutbox()
        switch status {
        case .refused, .notConfirmed: HostSignals.trouble()
        default: break
        }
        // The Mac's verdict, felt: success when it took it, an error when it refused.
        switch status {
        case .refused: Haptics.play(.refused)
        case .notConfirmed: Haptics.play(.notConfirmed)
        case .sending: break
        default: Haptics.play(.confirmed)
        }
    }

    private func remember(_ snapshot: PhoneSnapshot?) {
        for s in snapshot?.allSessions ?? [] where s.state != "working" {
            guard let text = [s.message, s.detail].compactMap({ $0 }).first(where: { !$0.isEmpty }) else { continue }
            remembered[s.key] = RememberedMessage(text: text, atISO: s.lastActivityAt, turnId: s.turnId)
        }
    }

    /// "Ask for Face ID to send" (this phone only, default on). Turning it off asks Face ID / passcode once.
    var asksForFaceID: Bool { sendConfirmation.asksForFaceID }

    func setAsksForFaceID(_ on: Bool) async -> Bool {
        if on == sendConfirmation.asksForFaceID { return true }
        if SendConfirmation.needsOwnerCheck(turningOn: on), !(await confirmOwner(reason: "Stop asking for Face ID to send")) { return false }
        sendConfirmation.asksForFaceID = on
        sendConfirmation.save(to: .standard)
        if on { unlock = SendUnlock() }
        return true
    }

    /// Face ID or the passcode, always: independent of "Ask for Face ID to send". True in demo and when the phone
    /// has neither set up (nothing to prove with, as `confirmWithBiometrics` treats it).
    func confirmOwner(reason: String) async -> Bool {
        if demo { return true }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    /// Face ID once, then not again until the app has been away for a while (`SendUnlock`).
    func confirmWithBiometrics(reason: String) async -> Bool {
        if demo || !sendConfirmation.needsConfirmation(unlock) { return true }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        let passed = (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
        if passed { unlock.authenticated() }
        return passed
    }
}

extension AppModel {
    /// Sends each photo to the Mac in signed chunks and returns the paths it saved them at. Face ID once
    /// first, like a send. Nothing is kept on the phone's side but what the caller holds.
    func upload(_ photos: [ChatPhoto], to target: AttachTarget, progress: @escaping @MainActor (Int, Int) -> Void) async -> UploadResult {
        if demo {
            for n in 0..<photos.count {
                progress(n, photos.count)
                try? await Task.sleep(for: .milliseconds(500))
            }
            return .saved(photos.enumerated().map { ".context/attachments/demo\($0.offset)00/image-1.jpg" })
        }
        guard await confirmWithBiometrics(reason: "Send a photo") else { return .failed("Face ID was cancelled.") }
        guard let channel else { return .failed("Not connected to your Mac.") }
        var refs: [String] = []
        for (n, photo) in photos.enumerated() {
            progress(n, photos.count)
            let uploadId = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(24).lowercased()
            let chunks = PhotoAttachment.chunks(of: photo.jpeg)
            for (index, chunk) in chunks.enumerated() {
                // A chunk whose answer never comes is sent once more under a new command id: the Mac ignores a
                // chunk it already has and repeats the ref of a photo it already saved. A refusal is final.
                var answer: CommandResult?
                var failure = "Your Mac didn't answer. Is Squeak running?"
                for _ in 0..<2 {
                    do {
                        let signer = self.signer
                        let (id, document) = try await Task.detached(priority: .userInitiated) { () -> (String, ChannelDocument) in
                            switch target {
                            case .session(let session):
                                guard let sessionId = session.conductorSessionId else { throw ChannelCrypto.Failure.badBox }
                                return try channel.attachDocument(sessionId: sessionId, uploadId: String(uploadId), index: index,
                                                                  total: chunks.count, chunk: chunk, signer: signer)
                            case .workspace(let workspaceId):
                                return try channel.attachDocument(workspaceId: workspaceId, uploadId: String(uploadId), index: index,
                                                                  total: chunks.count, chunk: chunk, signer: signer)
                            }
                        }.value
                        try await channel.send(document, id: id)
                        if let result = try await awaitResult(id, on: channel, within: 60) {
                            answer = result
                            break
                        }
                        failure = "Your Mac didn't answer. Is Squeak running?"
                    } catch {
                        failure = "Couldn't reach your Mac."
                    }
                }
                guard let result = answer else { return .failed(failure) }
                guard result.sent else { return .failed(result.reason ?? "Your Mac refused that photo.") }
                if index == chunks.count - 1 {
                    guard let ref = result.ref else { return .failed("Your Mac didn't say where it saved the photo.") }
                    refs.append(ref)
                    SentPhotos.save(photo.jpeg, for: ref)
                }
            }
        }
        progress(photos.count, photos.count)
        return .saved(refs)
    }
}

#endif
