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
    @Published private(set) var snapshot: PhoneSnapshot? { didSet { remember(snapshot) } }
    @Published private(set) var lastFetch: Date?
    @Published private(set) var problem: String?
    /// What this phone sent since the app opened, per session. Local only:
    /// the channel carries no conversation history back, so the phone shows
    /// its own replies and the Mac's latest message, nothing it cannot know.
    @Published private(set) var outbox: [String: [SentMessage]] = [:]

    typealias SentMessage = ChatSend

    /// The last agent message seen per session, so a working turn keeps the previous answer on screen.
    private(set) var remembered: [String: RememberedMessage] = [:]

    private var channel: Channel?
    private var loop: Task<Void, Never>?
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
    }

    /* ---------- the loop: only while the app is on screen ---------- */

    func resume() {
        guard !demo, loop == nil, channel != nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func pause() {
        loop?.cancel()
        loop = nil
    }

    func refresh() async {
        await tick()
    }

    private func tick() async {
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
                try await channel.touchPresence()
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

    /// Sends a reply. The message is on screen at once as "Sending…" and settles to one of the delivery
    /// lines (`ChatSend.Status.line`). Returns false when nothing was sent (empty, or Face ID declined),
    /// so the composer can give the text back.
    @discardableResult
    func send(_ text: String, to session: PhoneSnapshot.Session) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard await confirmWithBiometrics(reason: "Send to \(session.label)") else { return false }
        let sentId = begin(trimmed, for: session)
        if demo {
            try? await Task.sleep(for: .seconds(1))
            finish(sentId, .sent, for: session)
            return true
        }
        guard let channel else { finish(sentId, .refused("not connected to your Mac."), for: session); return true }
        do {
            let (id, document) = try channel.replyDocument(to: session, text: trimmed, signer: signer)
            try await channel.send(document, id: id)
            // The Mac answers within a few seconds while this app is open.
            for _ in 0..<40 {
                try await Task.sleep(for: .milliseconds(750))
                if let result = try await channel.result(for: id) {
                    finish(sentId, result.sent ? .sent : .refused(result.reason ?? "your Mac refused that reply."), for: session)
                    return true
                }
            }
            // Written, but the Mac never said: it may still arrive within its five minutes.
            finish(sentId, .notConfirmed, for: session)
        } catch {
            finish(sentId, .refused(error.localizedDescription), for: session)
        }
        return true
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
    }

    private func remember(_ snapshot: PhoneSnapshot?) {
        for s in snapshot?.sessions ?? [] where s.state != "working" {
            guard let text = [s.message, s.detail].compactMap({ $0 }).first(where: { !$0.isEmpty }) else { continue }
            remembered[s.key] = RememberedMessage(text: text, atISO: s.lastActivityAt, turnId: s.turnId)
        }
    }

    private func confirmWithBiometrics(reason: String) async -> Bool {
        if demo { return true }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}
#endif
