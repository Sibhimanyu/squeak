import AppKit
import Foundation
import Observation
import Sparkle
import SqueakMacCore
import SwiftUI

/// Sparkle 2, owned by the app. It only starts from the real bundle: a bare
/// `swift run`, a capture or the demo has no feed to read and no place to install to.
///
/// Squeak is a menu-bar app, so Sparkle's own scheduled alert would open behind whatever is in
/// front and never be seen. Scheduled updates are therefore "gentle": a banner in the panel and
/// Settings says "Update 2.x available", and the alert opens only when the app is already in focus
/// or the person asks. With automatic installs on (the default), most updates never ask at all:
/// they download quietly and install on the next quit, or from "Restart to update".
@MainActor
@Observable
final class AppUpdater {
    private(set) var canCheck = false
    /// Version string of an update Sparkle found and that is not installed yet.
    private(set) var availableVersion: String?
    /// Version of an update already downloaded and waiting to install when the app quits.
    private(set) var readyVersion: String?
    /// What changed in those versions, as plain bullets (empty when the appcast item has none).
    private(set) var availableNotes: [String] = []
    private(set) var readyNotes: [String] = []
    @ObservationIgnored private var controller: SPUStandardUpdaterController?
    @ObservationIgnored private var observation: NSKeyValueObservation?
    @ObservationIgnored private var delegate: UpdateDelegate?
    @ObservationIgnored fileprivate var installHandler: (() -> Void)?
    /// Told after every change to what is found or ready, so the model can badge and notify.
    @ObservationIgnored var onChange: (() -> Void)?
    /// Version the person chose to skip (Sparkle also remembers it); never notified about.
    @ObservationIgnored fileprivate(set) var skippedVersion: String?

    /// Capture and demo only (`SQUEAK_MAC_DEMO_UPDATE`): shows an update with no Sparkle behind it.
    func demoFound(_ version: String, notes: [String]) { found(version, notes: notes) }

    var isActive: Bool { controller != nil }

    var lastCheck: Date? { controller?.updater.lastUpdateCheckDate }

    /// Bound to Sparkle's own preference, so the toggle and its stored value cannot disagree.
    var automaticallyChecks: Bool {
        get { access(keyPath: \.automaticallyChecks); return controller?.updater.automaticallyChecksForUpdates ?? false }
        set {
            withMutation(keyPath: \.automaticallyChecks) { controller?.updater.automaticallyChecksForUpdates = newValue }
        }
    }

    /// Download and install without asking, taking effect on the next quit.
    var automaticallyInstalls: Bool {
        get { access(keyPath: \.automaticallyInstalls); return controller?.updater.automaticallyDownloadsUpdates ?? false }
        set {
            withMutation(keyPath: \.automaticallyInstalls) { controller?.updater.automaticallyDownloadsUpdates = newValue }
        }
    }

    func start(enabled: Bool) {
        guard enabled, controller == nil, Bundled.isApp, Bundle.main.bundleIdentifier == "com.squeak.mac" else { return }
        // Before the updater reads it: Sparkle's own default is off, and the Settings text promises installs.
        if UserDefaults.standard.object(forKey: "SUAutomaticallyUpdate") == nil {
            UserDefaults.standard.set(true, forKey: "SUAutomaticallyUpdate")
        }
        let d = UpdateDelegate(owner: self)
        delegate = d
        let c = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: d, userDriverDelegate: d)
        controller = c
        observation = c.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, change in
            let value = change.newValue ?? false
            Task { @MainActor in self?.canCheck = value }
        }
        AppLog.info("updates: Sparkle started")
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }

    /// "Restart to update": install the downloaded update now and relaunch.
    func installNow() {
        if let installHandler {
            QuitIntent.shared.updating = true
            installHandler()
        } else {
            checkForUpdates()
        }
    }

    // MARK: Called by the delegate (main thread)

    fileprivate func found(_ version: String?, notes: [String]) {
        let changed = version != availableVersion
        availableVersion = version
        if !notes.isEmpty || changed { availableNotes = notes }
        onChange?()
    }
    fileprivate func cleared(skipped: String? = nil) {
        if let skipped { skippedVersion = skipped }
        availableVersion = nil; readyVersion = nil; availableNotes = []; readyNotes = []; installHandler = nil
        onChange?()
    }
    fileprivate func ready(_ version: String?, notes: [String], handler: @escaping () -> Void) {
        readyVersion = version
        readyNotes = notes
        installHandler = handler
        onChange?()
    }
}

/// Sparkle ends an install by terminating the app without a `quit` Apple event, so it says so
/// first: that termination must be a real one (see `QuitPolicy`), or Sparkle could not relaunch us.
/// Set synchronously: Sparkle calls these on the main thread and may terminate right after, so a
/// `Task` would run too late, and its own update window would count as an open window to close.
final class UpdateDelegate: NSObject, SPUUpdaterDelegate, @preconcurrency SPUStandardUserDriverDelegate {
    private weak var owner: AppUpdater?

    init(owner: AppUpdater) { self.owner = owner }

    private func onMain(_ body: @escaping @MainActor () -> Void) {
        if Thread.isMainThread { MainActor.assumeIsolated(body) } else { DispatchQueue.main.sync { MainActor.assumeIsolated(body) } }
    }

    // MARK: Quit must succeed

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { onMain { QuitIntent.shared.updating = true } }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) { onMain { QuitIntent.shared.updating = true } }

    /// The download is staged and installs on the next real quit. Nothing here holds Sparkle back,
    /// and the installer stays reachable from the panel ("Restart to update").
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        let version = item.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: item.itemDescription)
        onMain {
            QuitIntent.shared.installPending = true
            self.owner?.ready(version, notes: notes, handler: immediateInstallHandler)
        }
        return true
    }

    /// A failed install must not leave the quit flag armed (the next Cmd-Q would quit instead of closing windows).
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        onMain {
            QuitIntent.shared.updating = false
            AppLog.info("updates: aborted: \(error.localizedDescription)")
        }
    }

    // MARK: What the panel shows

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: item.itemDescription)
        onMain { self.owner?.found(version, notes: notes) }
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) { onMain { self.owner?.cleared() } }

    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate updateItem: SUAppcastItem, state: SPUUserUpdateState) {
        if choice == .skip {
            let version = updateItem.displayVersionString
            onMain { self.owner?.cleared(skipped: version) }
        }
    }

    // MARK: Gentle reminders

    var supportsGentleScheduledUpdateReminders: Bool { true }

    /// Sparkle opens a scheduled alert itself only when it would be in utmost focus; otherwise it
    /// stays a banner (a menu-bar app's alert would open behind other windows and be missed).
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool {
        immediateFocus
    }

    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        let version = update.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: update.itemDescription)
        onMain {
            self.owner?.found(version, notes: notes)
            // The alert is about to show: an accessory app must be active, or it opens unseen.
            if handleShowingUpdate { NSApp.activate(ignoringOtherApps: true) }
        }
    }
}

/// "What's new" under an update banner: collapsed, and absent when the update carries no notes.
struct UpdateNotesDisclosure: View {
    let notes: [String]
    var size: CGFloat = 11.5
    @State private var open = false

    var body: some View {
        if !notes.isEmpty {
            DisclosureGroup("What's new", isExpanded: $open) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\u{2022}")
                            Text(note).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.top, 2)
            }
            .font(.system(size: size)).foregroundStyle(.secondary)
        }
    }
}
