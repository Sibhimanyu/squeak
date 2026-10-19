#if os(iOS)
import Foundation
import LocalAuthentication
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
    private(set) var snapshot: PhoneSnapshot? { didSet { remember(snapshot); settleStarting(snapshot) } }
    /// A chat the Mac accepted, until it shows up in the snapshot (the row's "Starting…").
    private(set) var startingChat: StartingChat?

    struct StartingChat: Equatable { let sessionId: String; let label: String }
    enum StartResult: Equatable { case started, cancelled, refused(String) }
    private(set) var lastFetch: Date?
    private(set) var problem: String?
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
    /// False once it is known the Mac's channel cannot stream (Firestore), so verbose cannot work.
    private(set) var liveAvailable = true

    @ObservationIgnored private var channel: Channel?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var unlock = SendUnlock()
    /// The session open on screen.
    @ObservationIgnored private var watching: String?
    @ObservationIgnored private var liveTask: Task<Void, Never>?
    /// How many recent chats Home has asked for; "Show more" adds 20, up to the Mac's 50.
    private(set) var recentWanted = 10
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
    @ObservationIgnored private var lastPresence = Date.distantPast
    @ObservationIgnored private let signer: CommandSigner
    let demo: Bool

    init() {
        demo = ProcessInfo.processInfo.arguments.contains("-squeak-demo")
        signer = demo ? SoftwareSigner() : KeyStore.signer()
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
            channel = Channel(pairing: pairing, deviceId: deviceId)
            phase = KeyStore.load(account: "approved") != nil ? .paired : .awaitingApproval(
                code: ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963), mac: pairing.n)
        }
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
                        keepAwake: current.keepAwake, awakeUntil: current.awakeUntil)
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
                if self?.liveTurns[key] != turn { self?.liveTurns[key] = turn; self?.noteQueue(turn, for: key) }
            }
        }
    }

    func refresh() async {
        await tick()
    }

    @ObservationIgnored private var ticking = false
    /// A change arrived while a fetch was running; fetch once more after it.
    @ObservationIgnored private var tickAgain = false

    private func tickIfAwaitingApproval() async {
        if case .awaitingApproval = phase { await tick() }
    }

    /// A view straight from the stream.
    private func apply(_ next: PhoneSnapshot?) {
        guard phase == .paired else { return }
        // An unchanged view must not redraw every screen.
        if let next, next != snapshot { snapshot = next }
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
            if let next = try await channel.snapshot(), next != snapshot {
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
        // Mode only means something mid-turn; an idle chat is simply sent.
        let mode: ReplyMode = session.state == "working" ? mode : .queue
        // On screen first, like any chat app: the bubble ("Sending…") and the agent's "Starting…"
        // row appear on the tap, and Face ID, signing and the network all happen behind them.
        UIImpactFeedbackGenerator(style: mode == .steer ? .medium : .light).impactOccurred()
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
        guard let channel else { finish(sentId, .refused("not connected to your Mac."), for: session); return true }
        do {
            let signer = signer
            let messageId = outbox[session.key]?.first(where: { $0.id == sentId })?.messageId
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.replyDocument(to: session, text: trimmed, mode: mode, messageId: messageId, signer: signer)
            }.value
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
                    recent: current.recent, keepAwake: current.keepAwake, awakeUntil: current.awakeUntil)
            }
            return .started
        }
        guard let channel else { return .refused("This iPhone isn't connected to your Mac.") }
        do {
            let signer = signer, workspaceId = workspace.id
            let (id, document) = try await Task.detached(priority: .userInitiated) {
                try channel.startDocument(workspaceId: workspaceId, agent: agent, text: text, signer: signer)
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

    /// Asks the Mac for a fresh Claude usage reading; the new numbers arrive in
    /// the snapshot. No Face ID: it reads, and sends nothing to an agent.
    /// Returns a line for the screen.
    /// Answers the question a chat is waiting on (ANSWER-CARD). Face ID first, like a reply: it is
    /// words to an agent. Returns the line to show under the card, and whether it was delivered.
    func answer(_ answers: [AnswerCommand.Answer], to session: PhoneSnapshot.Session) async -> (delivered: Bool, line: String) {
        guard let toolUseId = session.question?.toolUseId, let sessionId = session.conductorSessionId else {
            return (false, "Your Mac can't take answers from this phone yet. Update Squeak on your Mac.")
        }
        guard await confirmWithBiometrics(reason: "Answer in \(session.label)") else { return (false, "") }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if demo {
            try? await Task.sleep(for: .seconds(1))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return (true, "Answered")
        }
        guard let channel else { return (false, "Not connected to your Mac.") }
        do {
            let (id, document) = try channel.answerDocument(sessionId: sessionId, toolUseId: toolUseId, answers: answers, signer: signer)
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                return (false, "Your Mac didn't confirm it. Check the chat before answering again.")
            }
            guard result.answered || result.sent else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                return (false, result.reason ?? "Your Mac couldn't deliver that answer.")
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            let how = result.via == "stopped-and-sent" ? " · sent as a message after stopping the question" : ""
            return (true, (result.note ?? "Answered") + how)
        } catch {
            return (false, "Couldn't reach your Mac.")
        }
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
    }

    enum AwakeChange {
        case start(minutes: Int?)
        case extend(minutes: Int)
        case end
    }

    /// The session as last changed here, shown until the Mac's snapshot has had time to agree.
    private var awakeTapped: (status: AwakeStatus?, at: Date)?

    /// Whether this Mac offers awake sessions at all.
    var awakeOffered: Bool { snapshot?.keepAwake != nil }

    /// The running awake session, or nil when there is none.
    var awake: AwakeStatus? {
        if let tapped = awakeTapped, Date().timeIntervalSince(tapped.at) < 30 { return tapped.status }
        guard snapshot?.keepAwake == true else { return nil }
        return AwakeStatus(until: snapshot?.awakeUntil.flatMap(Self.parseISO))
    }

    private static func parseISO(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// Starts, extends or ends the Mac's awake session. No Face ID: it reaches no agent.
    /// Returns a line for the screen on failure.
    func changeAwake(_ change: AwakeChange) async -> String? {
        let expected: AwakeStatus?
        switch change {
        case .start(let minutes): expected = AwakeStatus(until: minutes.map { Date().addingTimeInterval(Double($0) * 60) })
        case .extend(let minutes): expected = AwakeStatus(until: awake?.until.map { max($0, Date()).addingTimeInterval(Double(minutes) * 60) })
        case .end: expected = nil
        }
        awakeTapped = (expected, Date())
        if demo { return nil }
        guard let channel else { awakeTapped = nil; return "Not connected to your Mac." }
        do {
            let (id, document): (String, ChannelDocument)
            switch change {
            case .start(let minutes): (id, document) = try channel.awakeDocument(on: true, minutes: minutes, signer: signer)
            case .extend(let minutes): (id, document) = try channel.awakeDocument(on: true, extend: minutes, signer: signer)
            case .end: (id, document) = try channel.awakeDocument(on: false, signer: signer)
            }
            try await channel.send(document, id: id)
            guard let result = try await awaitResult(id, on: channel) else {
                awakeTapped = nil
                return "Your Mac didn't answer. Is Squeak running?"
            }
            guard result.sent else { awakeTapped = nil; return result.reason ?? "Your Mac couldn't change that." }
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
        return send.id
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
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let refusal = await stopCommand(session)
        if let refusal {
            stopping[session.key] = nil
            problemFor[session.key] = refusal
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        } else {
            problemFor[session.key] = nil
        }
        return refusal
    }

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
        }
        // Once the Mac stops listing it, it went to the agent: its bubble says sent.
        for i in sends.indices where sends[i].seenInQueue && !ids.contains(sends[i].messageId) {
            if case .queued = sends[i].status { sends[i].status = .sent; changed = true }
        }
        if changed { outbox[key] = sends }
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
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let refusal = await queueCommand(.promote, card: card, session: session)
        if let refusal {
            outbox[session.key]?.removeAll { $0.id == steerId }
            hiddenQueued.remove(card.id)
            queueProblem[card.id] = refusal
            UINotificationFeedbackGenerator().notificationOccurred(.error)
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
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return nil
        }
        outbox[session.key]?.removeAll { $0.messageId == card.id }
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
