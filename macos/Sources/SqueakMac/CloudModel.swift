import Foundation
import Observation
import SqueakMacCore

/// Settings › Cloud and the pairing steps: what the daemon says about Squeak's hosted cloud.
/// `available` is false until the daemon answers `/control/cloud`; a 404 (an older daemon) hides the tab.
@MainActor @Observable
final class CloudModel {
    private(set) var state: CloudState?
    private(set) var available = false
    private(set) var reconnecting = false
    private(set) var notice: String?

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool

    init(client: DaemonClient, demo: Bool) { self.client = client; self.demo = demo }

    var hosted: HostedCloud? { state?.hosted }

    func refresh() async {
        guard !demo else { return }
        do {
            if let s = try await client.cloudState() { state = s; available = true } else { state = nil; available = false }
        } catch {
            // The daemon being down or busy is not "older": keep what was shown.
        }
    }

    /// Asks the daemon to connect (after sign-in, or by Reconnect), then watches until it settles.
    func connect() async {
        guard !demo, !reconnecting else { return }
        reconnecting = true
        notice = nil
        defer { reconnecting = false }
        let a = await client.connectHosted()
        if !a.ok { notice = a.error }
        await refresh()
        var tries = 0
        while !Task.isCancelled, hosted?.phase == .connecting, tries < 30 {
            try? await Task.sleep(for: .seconds(2))
            await refresh()
            tries += 1
        }
    }

    /// Re-reads while connecting, then stops.
    func pollWhileConnecting() async {
        while !Task.isCancelled, hosted?.phase == .connecting {
            try? await Task.sleep(for: .seconds(2))
            await refresh()
        }
    }
}
