#if os(iOS)
import Foundation
import LocalAuthentication
import SqueakCore
import SwiftUI
import UIKit

/// The whole app's state. It decides nothing about agents — the Mac does
/// (DESIGN.md §1, "every surface agrees") — it only fetches, shows and sends.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case unpaired
        /// Waiting for the Mac to approve; both screens show `code`.
        case awaitingApproval(code: String, mac: String)
        case paired
    }

    @Published private(set) var phase: Phase = .unpaired
    @Published private(set) var snapshot: PhoneSnapshot? { didSet { remember(snapshot); settleStarting(snapshot) } }
    /// A chat the Mac accepted, until it shows up in the snapshot (the row's "Starting…").
    @Published private(set) var startingChat: StartingChat?

    struct StartingChat: Equatable { let sessionId: String; let label: String }
    enum StartResult: Equatable { case started, cancelled, refused(String) }
    @Published private(set) var lastFetch: Date?
    @Published private(set) var problem: String?
    /// What this phone sent since the app opened, per session. Local only:
    /// the channel carries no conversation history back, so the phone shows
    /// its own replies and the Mac's latest message, nothing it cannot know.
    @Published private(set) var outbox: [String: [SentMessage]] = [:]

    typealias SentMessage = ChatSend

    /// The last agent message seen per session, so a working turn keeps the previous answer on screen.
    private(set) var remembered: [String: RememberedMessage] = [:]

    /// "Show thinking live" (Settings): the open session's whole turn, as it
    /// happens, instead of its newest six steps. Off by default; the Mac
    /// sends it only while this phone has that session open.
    @Published var verbose: Bool = UserDefaults.standard.bool(forKey: "squeak.verbose") {
        didSet {
            UserDefaults.standard.set(verbose, forKey: "squeak.verbose")
            restartLive()
        }
    }
    /// The verbose view per session key, while it is being watched.
    @Published private(set) var liveTurns: [String: LiveTurn] = [:]
    /// False once it is known the Mac's channel cannot stream (Firestore), so verbose cannot work.
    @Published private(set) var liveAvailable = true

    private var channel: Channel?
    private var loop: Task<Void, Never>?
    private var unlock = SendUnlock()
    /// The session open on screen.
    private var watching: String?
    private var liveTask: Task<Void, Never>?
    /// How many recent chats Home has asked for; "Show more" adds 20, up to the Mac's 50.
    @Published private(set) var recentWanted = 10
    /// Sent only once more is asked for, so a phone at the default writes the same presence as before.
    private var recentAsk: Int? { recentWanted > 10 ? recentWanted : nil }

    /// Ask the Mac for 20 more recent chats; they arrive with the next view.
    func showMoreRecent() {
        guard recentWanted < 50 else { return }
        recentWanted = min(50, recentWanted + 20)
        guard !demo, let channel else { return }
        let watching = presenceWatching, recent = recentAsk
        Task { try? await channel.touchPresence(watching: watching, recent: recent) }
    }

    /// What presence tells the Mac to stream: only in verbose mode.
    private var presenceWatching: String? { verbose ? watching : nil }
    private var lastPresence = Date.distantPast
    private let signer: CommandSigner
    let demo: Bool

    init() {
        demo = ProcessInfo.processInfo.arguments.contains("-squeak-demo")
        signer = demo ? SoftwareSigner() : KeyStore.signer()
        if demo {
            snapshot = DemoData.snapshot
            outbox = DemoData.outbox
            for (k, v) in DemoData.remembered { remembered[k] = v }
            lastFetch = Date()
            phase = .paired
            return
        }
        if let data = KeyStore.load(account: "pairing"),
           let pairing = try? JSONDecoder().decode(PairingPayload.self, from: data),
           let deviceId = KeyStore.load(account: "device-id").flatMap({ String(data: $0, encoding: .utf8) }) {
            channel = Channel(pairing: pairing, deviceId: deviceId)
            phase = KeyStore.load(account: "approved") != nil ? .paired : .awaitingApproval(
                code: ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963), mac: pairing.n)
        }
    }

    /* ---------- pairing ---------- */

    func pair(with text: String) async {
        do {
            let pairing = try PairingPayload.parse(text)
            let deviceId = UUID().uuidString.lowercased()
            let channel = Channel(pairing: pairing, deviceId: deviceId)
            try await channel.requestPairing(name: UIDevice.current.name, signer: signer)
            KeyStore.save(try JSONEncoder().encode(pairing), account: "pairing")
            KeyStore.save(Data(deviceId.utf8), account: "device-id")
            self.channel = channel
            problem = nil
            phase = .awaitingApproval(code: ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963), mac: pairing.n)
            resume()
        } catch is PairingPayload.Failure {
            problem = "That isn't a Squeak pairing code. Open Squeak on your Mac, choose iPhone, then Pair an iPhone."
        } catch {
            problem = "Couldn't reach Squeak's server. Check the connection and scan again."
        }
    }

    func unpair() {
        KeyStore.wipe()
        KeyStore.delete(account: "approved")
        channel = nil
        snapshot = nil
        phase = .unpaired
        loop?.cancel()
        liveTask?.cancel()
        liveTask = nil
        liveTurns = [:]
    }

    /* ---------- the loop: only while the app is on screen ---------- */

    func resume() {
        unlock.foregrounded()
        guard !demo, loop == nil, let channel else { return }
        loop = Task { [weak self] in
            await self?.tick()
            self?.restartLive()
            guard let snapshots = await channel.snapshots(), let results = await channel.resultChanges() else {
                // Firestore: look again every couple of seconds.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(Self.pollSeconds))
                    await self?.tick()
                }
                return
            }
            // Realtime Database: a new view (or the Mac's pairing answer)
            // arrives as it is written, carried in the event itself so it is
            // downloaded once. The slow tick only keeps presence fresh, and
            // re-reads only if the view has gone quiet for a minute.
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    do {
                        for try await next in snapshots { await self?.apply(next) }
                    } catch {
                        await self?.tick() // undecryptable: let the full read say why
                    }
                }
                group.addTask { for await _ in results { await self?.tickIfAwaitingApproval() } }
                group.addTask {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(Self.streamedTickSeconds))
                        await self?.keepAlive()
                    }
                }
            }
        }
    }

    /// How often the phone looks for a new view while it is on screen, when
    /// it has to poll. The Mac publishes within about a second of a change, so
    /// this is most of what a finish waits for on the phone.
    static let pollSeconds = 2
    /// When streamed: presence must reach the Mac inside its 60s window.
    static let streamedTickSeconds = 20

    func pause() {
        unlock.backgrounded()
        loop?.cancel()
        loop = nil
        let wasStreaming = presenceWatching != nil
        liveTask?.cancel()
        liveTask = nil
        // Ask the Mac to stop (and delete) the live turn now rather than when presence lapses.
        if wasStreaming, let channel { Task { try? await channel.touchPresence(watching: nil, recent: recentAsk) } }
    }

    /// The session on screen, or nil when none is. In verbose mode the Mac streams its turn.
    func watch(_ key: String?) {
        guard watching != key else { return }
        watching = key
        restartLive()
    }

    /// Tell the Mac what this phone watches now, and follow that session's live turn.
    private func restartLive() {
        liveTask?.cancel()
        liveTask = nil
        guard !demo, loop != nil, let channel else { return }
        let key = presenceWatching
        liveTask = Task { [weak self] in
            try? await channel.touchPresence(watching: key, recent: recentAsk)
            self?.lastPresence = Date()
            guard let key else { return }
            guard let turns = await channel.liveTurns(for: key) else {
                self?.liveAvailable = false
                return
            }
            self?.liveAvailable = true
            for await turn in turns {
                if Task.isCancelled { break }
                self?.liveTurns[key] = turn
            }
        }
    }

    func refresh() async {
        await tick()
    }

    private var ticking = false
    /// A change arrived while a fetch was running; fetch once more after it.
    private var tickAgain = false

    private func tickIfAwaitingApproval() async {
        if case .awaitingApproval = phase { await tick() }
    }

    /// A view straight from the stream.
    private func apply(_ next: PhoneSnapshot?) {
        guard phase == .paired else { return }
        if let next { snapshot = next }
        lastFetch = Date()
        problem = nil
    }

    /// Streamed: keep presence inside the Mac's window. No re-read: a quiet
    /// Mac is normal, and a dead stream reconnects by itself and is sent the
    /// whole view again. A presence write that lands proves the channel is
    /// up, so it counts as synced.
    private func keepAlive() async {
        guard let channel else { return }
        guard phase == .paired else { await tick(); return }
        do {
            try await channel.touchPresence(watching: presenceWatching, recent: recentAsk)
            lastPresence = Date()
            lastFetch = Date()
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
                        phase = .paired
                    } else {
                        unpair()
                        problem = "Your Mac said no. Pair again if that was a mistake."
                    }
                }
                return
            }
            // Tell the Mac someone is looking, so it publishes and polls faster.
            if Date().timeIntervalSince(lastPresence) > 20 {
                try await channel.touchPresence(watching: presenceWatching, recent: recentAsk)
                lastPresence = Date()
            }
            if let next = try await channel.snapshot() {
                snapshot = next
            }
            lastFetch = Date()
            problem = nil
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
        guard await confirmWithBiometrics(reason: "Send to \(session.label)") else { return false }
        // Mode only means something mid-turn; an idle chat is simply sent.
        let mode: ReplyMode = session.state == "working" ? mode : .queue
        // A tap on send; a firmer one for a steer, which interrupts.
        UIImpactFeedbackGenerator(style: mode == .steer ? .medium : .light).impactOccurred()
        let sentId = begin(trimmed, for: session)
        let agent = Presentation.agentName(session.agent)
        if demo {
            try? await Task.sleep(for: .seconds(1))
            let working = session.state == "working"
            finish(sentId, !working ? .sent : mode == .steer ? .steered : .queued(agent: agent, steerUnavailable: false), for: session)
            return true
        }
        guard let channel else { finish(sentId, .refused("not connected to your Mac."), for: session); return true }
        do {
            let (id, document) = try channel.replyDocument(to: session, text: trimmed, mode: mode, signer: signer)
            try await channel.send(document, id: id)
            // The Mac answers within a few seconds while this app is open.
            if let result = try await awaitResult(id, on: channel) {
                finish(sentId, result.sent ? .delivered(result, agent: agent) : .refused(result.reason ?? "your Mac refused that reply."), for: session)
                return true
            }
            // Written, but the Mac never said: it may still arrive within its five minutes.
            finish(sentId, .notConfirmed, for: session)
        } catch {
            finish(sentId, .refused(error.localizedDescription), for: session)
        }
        return true
    }

    /// The Mac's answer to command `id`, or nil after 30 seconds. Streamed, it
    /// is read the moment the Mac writes it; otherwise every 750 ms.
    private func awaitResult(_ id: String, on channel: Channel) async throws -> CommandResult? {
        let deadline = Date().addingTimeInterval(30)
        guard let changes = await channel.resultChanges() else {
            while Date() < deadline {
                try await Task.sleep(for: .milliseconds(750))
                if let result = try await channel.result(for: id) { return result }
            }
            return nil
        }
        return try await withThrowingTaskGroup(of: CommandResult?.self) { group in
            group.addTask {
                for await _ in changes {
                    if let result = try await channel.result(for: id) { return result }
                }
                return nil
            }
            group.addTask {
                try await Task.sleep(for: .seconds(deadline.timeIntervalSinceNow))
                return try await channel.result(for: id) // one last look
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /* ---------- starting a chat ---------- */

    /// Asks the Mac to start a chat in `workspace`. Face ID first, like a reply. On success the new chat
    /// is opened as soon as the snapshot has it (`SqueakRouter`), and the list shows "Starting…" until then.
    func startChat(in workspace: PhoneSnapshot.Workspace, agent: NewChatAgent, text: String) async -> StartResult {
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
                    recent: current.recent)
            }
            return .started
        }
        guard let channel else { return .refused("This iPhone isn't connected to your Mac.") }
        do {
            let (id, document) = try channel.startDocument(workspaceId: workspace.id, agent: agent, text: text, signer: signer)
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

    /// Asks the Mac for a fresh Claude usage reading; the new numbers arrive in
    /// the snapshot. No Face ID: it reads, and sends nothing to an agent.
    /// Returns a line for the screen.
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

    /// Any send of this session still waiting on the Mac.
    func isSending(_ key: String) -> Bool { outbox[key]?.contains { $0.status == .sending } ?? false }

    private func begin(_ text: String, for session: PhoneSnapshot.Session) -> UUID {
        let send = ChatSend(text: text, date: Date(), answersTurn: session.turnId ?? remembered[session.key]?.turnId, status: .sending)
        outbox[session.key, default: []].append(send)
        return send.id
    }

    private func finish(_ id: UUID, _ status: ChatSend.Status, for session: PhoneSnapshot.Session) {
        guard let i = outbox[session.key]?.firstIndex(where: { $0.id == id }) else { return }
        outbox[session.key]?[i].status = status
        // The Mac's verdict, felt: success when it took it, an error when it refused.
        switch status {
        case .refused: UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .notConfirmed: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        default: UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }

    private func remember(_ snapshot: PhoneSnapshot?) {
        for s in snapshot?.allSessions ?? [] where s.state != "working" {
            guard let text = [s.message, s.detail].compactMap({ $0 }).first(where: { !$0.isEmpty }) else { continue }
            remembered[s.key] = RememberedMessage(text: text, atISO: s.lastActivityAt, turnId: s.turnId)
        }
    }

    /// Face ID once, then not again until the app has been away for a while (`SendUnlock`).
    private func confirmWithBiometrics(reason: String) async -> Bool {
        if demo || !unlock.needsAuthentication { return true }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        let passed = (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
        if passed { unlock.authenticated() }
        return passed
    }
}
#endif
