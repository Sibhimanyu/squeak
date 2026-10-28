import Foundation
import Observation
import SqueakMacCore

/// Conductor's relay for the Mac window: read from the daemon, set up and reset through its routes. The daemon
/// decides the state and the sentences; this only holds them. Setup and reset run once and are never retried.
@MainActor @Observable
final class RelayModel {
    private(set) var status: RelayStatus?
    /// The daemon predates the relay routes: the page says to update the background service.
    private(set) var needsServiceUpdate = false
    /// A setup or reset is in flight.
    private(set) var busy = false
    /// The daemon's reason when the last setup or reset failed; cleared by the next try.
    private(set) var problem: String?

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool

    init(client: DaemonClient, demo: Bool) {
        self.client = client
        self.demo = demo
        if demo { status = Self.demoStatus }
    }

    /// Demo mode: connected, no network.
    static let demoStatus = RelayStatus(
        state: .connected, conductorInstalled: true, conductorVersion: "0.91.2", versionTested: true,
        configured: true, paired: true, hostConnected: true, port: 8478,
        message: "Conductor is connected. New chats and live replies work.", steps: [])

    func refresh() async {
        guard !demo else { return }
        do {
            if let s = try await client.relayStatus() {
                needsServiceUpdate = false
                if s != status { status = s }
            } else {
                needsServiceUpdate = true
            }
        } catch {
            // Daemon down or token trouble: keep what was last read; Connections says why.
        }
    }

    func setUp(force: Bool = false) async {
        guard !busy else { return }
        if demo { return }
        busy = true; problem = nil
        let result = await client.setupRelay(force: force)
        apply(result)
        busy = false
        await refresh()
    }

    func reset() async {
        guard !busy else { return }
        if demo { return }
        busy = true; problem = nil
        let result = await client.resetRelay()
        apply(result)
        busy = false
        await refresh()
    }

    private func apply(_ result: RelayActionResult) {
        if let s = result.status { status = s }
        if result.reason == RelayStatus.updateServiceSentence { needsServiceUpdate = true }
        if !result.ok { problem = result.reason }
    }

    /// Poll while a page that shows it is open: every 3 s until the task is cancelled.
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(3))
        }
    }
}
