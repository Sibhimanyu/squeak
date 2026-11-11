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
    /// Why the last start failed, for "Copy details"; nil once it runs.
    private(set) var failure: DaemonFailure?
    /// What the installer is doing now, for the setup step's one line.
    private(set) var step: DaemonStep?
    /// When the current run began; setup calls it failed once it has run too long.
    private(set) var busySince: Date?
    /// Bumped when a run passes setup's deadline, so the screen reads the clock again.
    private(set) var deadlineTick = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let runner: DaemonInstallerRunner
    @ObservationIgnored private let enabled: Bool

    init(enabled: Bool) {
        self.enabled = enabled
        runner = DaemonInstallerRunner(effects: LiveDaemonEffects())
    }

    /// Called once at launch (after an update, the relaunched app lands here too).
    func reconcileAtLaunch() {
        AppInstall.writeForRunningApp()
        run(userRequested: false)
    }

    /// The Install, Repair and Restart button.
    func repair() { run(userRequested: true) }

    /// Setup's Try again: clears whatever a failed or stuck start left and runs the whole setup again, whether or not
    /// the last run ever came back.
    func retryFromScratch() { run(userRequested: true, fresh: true) }

    /// The app came back to the front: if macOS was waiting for the person to allow the background item, look again.
    func recheckPermission() {
        guard enabled, !busy, case .needsApproval = status else { return }
        run(userRequested: true)
    }

    /// Where the service writes, for "Show log".
    var logFile: URL { LiveDaemonEffects.Paths.standard().logFile }

    private func run(userRequested: Bool, fresh: Bool = false) {
        guard enabled, fresh || !busy else { return }
        generation += 1
        let mine = generation
        task?.cancel()
        busy = true
        busySince = Date()
        step = nil
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(SetupServiceFact.serviceDeadline + 0.5))
            guard let self, generation == mine, busy else { return }
            deadlineTick += 1
        }
        task = Task { [weak self] in
            guard let self else { return }
            let onStatus: @Sendable (DaemonStatus) -> Void = { s in
                Task { @MainActor [weak self] in if self?.generation == mine { self?.status = s } }
            }
            let onStep: @Sendable (DaemonStep) -> Void = { s in
                Task { @MainActor [weak self] in if self?.generation == mine { self?.step = s } }
            }
            let result = fresh
                ? await runner.retryFromScratch(onStatus: onStatus, onStep: onStep)
                : await runner.reconcile(userRequested: userRequested, onStatus: onStatus, onStep: onStep)
            guard generation == mine else { return }  // a newer try replaced this one
            status = result
            switch result {
            case .upToDate(let v): version = v
            case .failed(_, let running): version = running
            default: break
            }
            failure = { if case .failed = result { LiveDaemonEffects.readFailure() } else { nil } }()
            busy = false
            busySince = nil
            step = nil
            AppInstall.writeForRunningApp()
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
            Button(button) {
                if case .needsApproval = daemon.status { BackgroundApproval.openLoginItemsSettings() } else { daemon.repair() }
            }.disabled(daemon.busy)
        }
        if case .failed(let reason, _) = daemon.status {
            ReportProblemButton(problem: "Background service: \(reason)", place: "Settings › About",
                                details: daemon.failure?.details)
        }
    }

    private var buttonTitle: String? {
        switch daemon.status {
        case .notInstalled: "Install background service"
        case .upToDate: "Restart"
        case .failed: "Repair"
        case .needsApproval: "Open Login Items Settings"
        default: nil
        }
    }

    static func footnote(_ s: DaemonStatus) -> String {
        switch s {
        case .failed(let reason, _): reason
        case .needsApproval: "macOS has Squeak's background item switched off. Allow it in Login Items, then Squeak starts it."
        case .devCheckout: "A launch agent runs Squeak from a source checkout. Squeak leaves it alone."
        case .external: "Something else already answers on this Mac's Squeak port."
        case .notInstalled: "Squeak needs its background service to watch every agent session and answer from your phone."
        case .unavailable: "This build of Squeak carries no background service."
        default: "Squeak updates this along with the app."
        }
    }
}
