import Foundation
import Observation
import Sparkle

/// Sparkle 2, owned by the app. It only starts from the real bundle: a bare
/// `swift run`, a capture or the demo has no feed to read and no place to install to.
@MainActor
@Observable
final class AppUpdater {
    private(set) var canCheck = false
    @ObservationIgnored private var controller: SPUStandardUpdaterController?
    @ObservationIgnored private var observation: NSKeyValueObservation?
    @ObservationIgnored private let delegate = UpdateQuitDelegate()

    var isActive: Bool { controller != nil }

    var lastCheck: Date? { controller?.updater.lastUpdateCheckDate }

    /// Bound to Sparkle's own preference, so the toggle and its stored value cannot disagree.
    var automaticallyChecks: Bool {
        get { access(keyPath: \.automaticallyChecks); return controller?.updater.automaticallyChecksForUpdates ?? false }
        set {
            withMutation(keyPath: \.automaticallyChecks) { controller?.updater.automaticallyChecksForUpdates = newValue }
        }
    }

    func start(enabled: Bool) {
        guard enabled, controller == nil, Bundled.isApp, Bundle.main.bundleIdentifier == "com.squeak.mac" else { return }
        let c = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: delegate, userDriverDelegate: nil)
        controller = c
        observation = c.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, change in
            let value = change.newValue ?? false
            Task { @MainActor in self?.canCheck = value }
        }
        AppLog.info("updates: Sparkle started")
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }
}

/// Sparkle ends an install by terminating the app without a `quit` Apple event, so it says so
/// first: that termination must be a real one (see `QuitPolicy`), or Sparkle could not relaunch us.
final class UpdateQuitDelegate: NSObject, SPUUpdaterDelegate {
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        Task { @MainActor in QuitIntent.shared.updating = true }
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        Task { @MainActor in QuitIntent.shared.updating = true }
    }
}
