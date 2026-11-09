import Foundation
import Observation
import SqueakMacCore

/// Conductor's relay for the Mac window: read from the daemon, set up and reset through its routes. The daemon
/// decides the state and the sentences; this only holds them. Setup and reset run once and are never retried.
/// It is the Conductor link add-on (`ConductorLinkAddon`): the app draws `page` and reads `reading`.
@MainActor @Observable
public final class RelayModel: ConductorLinkAddon {
    public private(set) var status: RelayStatus?
    /// The daemon predates the relay routes: the page says to update the background service.
    public private(set) var needsServiceUpdate = false
    /// A setup or reset is in flight.
    public private(set) var busy = false
    /// The daemon's reason when the last setup or reset failed; cleared by the next try.
    public private(set) var problem: String?

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool

    public init(client: DaemonClient, demo: Bool) {
        self.client = client
        self.demo = demo
        if demo { status = Self.demoStatus }
    }

    /// Demo mode: connected, no network.
    static let demoStatus = RelayStatus(
        state: .connected, conductorInstalled: true, conductorVersion: "0.91.2", versionTested: true,
        configured: true, paired: true, hostConnected: true, port: 8478,
        message: "Conductor is connected. New chats and live replies work.", steps: [])

    public func refresh() async {
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

    public func setUp() async { await setUp(force: false) }

    func setUp(force: Bool) async {
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
    public func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(3))
        }
    }

    // MARK: ConductorLinkAddon

    public var reading: ConductorLinkReading? {
        guard let s = status else { return nil }
        let state: ConductorLinkReading.State
        switch s.state {
        case .connected: state = .connected
        case .notInstalled: state = .notInstalled
        case .error, .unknown: state = .failed
        case .off, .unsupported, .needsRestart, .waiting: state = .pending
        }
        return ConductorLinkReading(state: state, message: s.message, conductorInstalled: s.conductorInstalled)
    }

    /// Whether a chat's error text is "the relay is not connected", so a surface can offer Conductor settings.
    public func isLinkProblem(_ text: String?) -> Bool { RelayStatus.isRelayProblem(text) }

    public var page: AddonPage {
        let title = "Your Conductor connection"
        let subtitle = "Bring agent sessions and replies into Squeak."
        let place = "Settings › Conductor"
        guard needsServiceUpdate || status != nil else {
            return AddonPage(title: title, subtitle: subtitle, symbol: "terminal", loading: "Checking Conductor…")
        }
        if needsServiceUpdate {
            return AddonPage(
                title: title, subtitle: subtitle, symbol: "terminal",
                headline: .init(tone: .quiet, text: ServiceSentence.updateService),
                notes: ["This version of the Squeak service can't set up Conductor. Update it from Settings › Connections and this page fills in."])
        }
        let s = status!
        let message = s.message.isEmpty ? Self.fallback(s.state) : s.message
        var notes: [String] = []
        if s.state == .unsupported { notes.append("This Conductor version hasn't been tested with Squeak. Setting up anyway may not work.") }
        if s.state == .needsRestart { notes.append("Quit Conductor completely and open it again so it picks up the link.") }
        return AddonPage(
            title: title, subtitle: subtitle, symbol: "terminal",
            headline: .init(tone: Self.tone(s.state), text: message),
            steps: s.steps, notes: notes, problem: problem, reportPlace: place,
            reportProblem: problem ?? (s.state == .error ? message : nil),
            actions: actions(for: s.state), busy: busy)
    }

    private func actions(for state: RelayState) -> [AddonPage.Action] {
        switch state {
        case .off, .error, .unknown:
            [.init(id: "setup", title: "Set up Conductor", primary: true, disabled: busy) { [weak self] in await self?.setUp() }]
        case .needsRestart:
            [.init(id: "restarted", title: "I restarted Conductor", primary: true, disabled: busy) { [weak self] in await self?.refresh() }]
        case .waiting:
            [.init(id: "check", title: "Check again") { [weak self] in await self?.refresh() }]
        case .connected:
            [.init(
                id: "reset", title: "Reset", disabled: busy,
                confirmation: .init(
                    title: "Reset Conductor link?",
                    message: "This removes Squeak's link to Conductor; new chats and live replies stop until you set it up again.",
                    confirmTitle: "Reset", destructive: true)
            ) { [weak self] in await self?.reset() }]
        case .unsupported:
            [.init(
                id: "force", title: "Set up anyway", disabled: busy,
                confirmation: .init(
                    title: "Set up anyway?", message: "This Conductor version isn't tested with Squeak.", confirmTitle: "Set up anyway")
            ) { [weak self] in await self?.setUp(force: true) }]
        case .notInstalled:
            []
        }
    }

    private static func tone(_ s: RelayState) -> AddonPage.Tone {
        switch s {
        case .connected: .good
        case .waiting, .needsRestart, .error, .unknown: .bad
        case .off, .unsupported, .notInstalled: .quiet
        }
    }

    private static func fallback(_ s: RelayState) -> String {
        switch s {
        case .connected: "Connected"
        case .notInstalled: "Conductor isn't installed"
        default: "Not connected"
        }
    }
}
