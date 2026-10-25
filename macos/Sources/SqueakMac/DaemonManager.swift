import Foundation
import Observation
import SqueakMacCore
import SwiftUI

/// Owns the background service for installs that have no checkout: at launch it brings the daemon
/// bundled in the app (Contents/Resources/daemon) to ~/Library/Application Support/squeak/daemon/<version>,
/// outside the app so a Sparkle update never breaks the running daemon. A launch agent that runs a git
/// checkout is the owner's dev loop and is never touched. A first install waits for the person's press.
@MainActor @Observable
final class DaemonManager {
    private(set) var status: DaemonStatus = .unavailable
    private(set) var busy = false
    private(set) var version: String?
    @ObservationIgnored private let runner: DaemonInstallerRunner
    @ObservationIgnored private let enabled: Bool

    init(enabled: Bool) {
        self.enabled = enabled
        runner = DaemonInstallerRunner(effects: LiveDaemonEffects())
    }

    /// Called once at launch (after an update, the relaunched app lands here too).
    func reconcileAtLaunch() { run(userRequested: false) }

    /// The Install, Repair and Restart button.
    func repair() { run(userRequested: true) }

    private func run(userRequested: Bool) {
        guard enabled, !busy else { return }
        busy = true
        Task { [weak self] in
            guard let self else { return }
            let result = await runner.reconcile(userRequested: userRequested) { s in
                Task { @MainActor [weak self] in self?.status = s }
            }
            status = result
            switch result {
            case .upToDate(let v): version = v
            case .failed(_, let running): version = running
            default: break
            }
            busy = false
            AppLog.info("background service: \(result.label)")
            if case .failed(let reason, _) = result { AppLog.error("background service: \(reason)") }
        }
    }
}

/// Settings › About › Background service.
struct BackgroundServiceRow: View {
    let daemon: DaemonManager

    var body: some View {
        LabeledContent("Background service") {
            VStack(alignment: .trailing, spacing: 2) {
                Text(daemon.status.label)
                if let v = daemon.version { Text(v).font(.caption).foregroundStyle(.secondary) }
            }
        }
        if let button = buttonTitle {
            Button(button) { daemon.repair() }.disabled(daemon.busy)
        }
    }

    private var buttonTitle: String? {
        switch daemon.status {
        case .notInstalled: "Install background service"
        case .upToDate: "Restart"
        case .failed: "Repair"
        default: nil
        }
    }

    static func footnote(_ s: DaemonStatus) -> String {
        switch s {
        case .failed(let reason, _): reason
        case .devCheckout: "A launch agent runs Squeak from a source checkout. Squeak leaves it alone."
        case .external: "Something else already answers on this Mac's Squeak port."
        case .notInstalled: "Squeak needs its background service to watch every agent session and answer from your phone."
        case .unavailable: "This build of Squeak carries no background service."
        default: "Squeak updates this along with the app."
        }
    }
}
