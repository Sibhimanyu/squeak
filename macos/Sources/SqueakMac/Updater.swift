import AppKit
import Foundation
import Observation
import Sparkle
import SqueakMacCore
import SwiftUI

/// Sparkle 2, owned by the app. It only starts from the real bundle: a bare
/// `swift run`, a capture or the demo has no feed to read and no place to install to.
///
/// This class is a thin adapter. What the update is doing, and when it has waited too long, lives in
/// `UpdateFlow` (SqueakMacCore, pure and tested); every Sparkle callback, whoever started the session, and every tap
/// goes in as an event, and the flow's commands come back here to be carried out. The popup banner, Settings and the
/// update window all draw the same `flow`.
///
/// Squeak is a menu-bar app, so Sparkle's own scheduled alert would open behind whatever is in front and never be
/// seen. Scheduled updates are therefore "gentle": a banner in the panel and Settings says "Update 2.x available".
/// With automatic installs on (the default) Sparkle's automatic driver downloads without ever calling the user
/// driver, so those sessions are followed through the updater delegate (`willDownloadUpdate`, `willExtractUpdate`,
/// `willInstallUpdateOnQuit`, errors) and show the same progress. Sparkle gives no handle to cancel or join that
/// kind of session, and `checkForUpdates()` is a silent no-op while one runs: so a press while it runs attaches to
/// its progress, queues what the person asked for, and the flow's timeouts turn a hung session into a failure with a
/// way out. Everything is written to `updates.log` (`UpdateLog`).
@MainActor
@Observable
final class AppUpdater {
    private(set) var canCheck = false
    private(set) var flow = UpdateFlow()
    fileprivate var permissionAction: ((Bool) -> Void)?
    fileprivate var retryInstallation: (() -> Void)?
    private(set) var updateWindow: UpdateWindowController?
    /// Version string of an update Sparkle found and that is not installed yet.
    private(set) var availableVersion: String?
    /// Version of an update already downloaded and waiting to install when the app quits.
    private(set) var readyVersion: String?
    /// What changed in those versions, as plain bullets (empty when the appcast item has none).
    fileprivate(set) var availableNotes: [String] = []
    private(set) var readyNotes: [String] = []
    fileprivate(set) var informationOnly = false
    fileprivate(set) var informationURL: URL?
    /// Sparkle gave us something to cancel the running session with.
    fileprivate(set) var cancellable = false
    @ObservationIgnored private var updater: SPUUpdater?
    @ObservationIgnored private var observation: NSKeyValueObservation?
    @ObservationIgnored fileprivate var userDriver: UpdateUserDriver?
    @ObservationIgnored private var delegate: UpdateDelegate?
    @ObservationIgnored fileprivate var installHandler: (() -> Void)?
    /// The person pressed Install before Sparkle offered the update: reply "install" the moment it does.
    @ObservationIgnored fileprivate var acceptOnOffer = false
    @ObservationIgnored private var tickTask: Task<Void, Never>?
    /// Told after every change to what is found or ready, so the model can badge and notify.
    @ObservationIgnored var onChange: (() -> Void)?
    /// Version the person chose to skip (Sparkle also remembers it); never notified about.
    @ObservationIgnored fileprivate(set) var skippedVersion: String?
    @ObservationIgnored fileprivate let updateLog = UpdateLog.standard

    /// Capture and demo only (`SQUEAK_MAC_DEMO_UPDATE`): shows an update with no Sparkle behind it.
    func demoFound(_ version: String, notes: [String]) {
        found(version, notes: notes)
        dispatch(.updateFound(version: version))
    }

    var isActive: Bool { updater != nil }

    /// Anything running or waiting on the person: the menu's "Check for updates…" stays pressable to show it.
    var isBusy: Bool { flow.phase != .idle }

    var lastCheck: Date? { updater?.lastUpdateCheckDate }

    /// Bound to Sparkle's own preference, so the toggle and its stored value cannot disagree.
    var automaticallyChecks: Bool {
        get { access(keyPath: \.automaticallyChecks); return updater?.automaticallyChecksForUpdates ?? false }
        set {
            withMutation(keyPath: \.automaticallyChecks) { updater?.automaticallyChecksForUpdates = newValue }
        }
    }

    /// Download and install without asking, taking effect on the next quit.
    var automaticallyInstalls: Bool {
        get { access(keyPath: \.automaticallyInstalls); return updater?.automaticallyDownloadsUpdates ?? false }
        set {
            withMutation(keyPath: \.automaticallyInstalls) { updater?.automaticallyDownloadsUpdates = newValue }
        }
    }

    func start(enabled: Bool) {
        guard enabled, updater == nil, Bundled.isApp, Bundle.main.bundleIdentifier == "com.squeak.mac" else { return }
        // Before the updater reads it: Sparkle's own default is off, and the Settings text promises installs.
        if UserDefaults.standard.object(forKey: "SUAutomaticallyUpdate") == nil {
            UserDefaults.standard.set(true, forKey: "SUAutomaticallyUpdate")
        }
        let d = UpdateDelegate(owner: self)
        delegate = d
        let ui = UpdateUserDriver(owner: self)
        userDriver = ui
        let u = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: ui, delegate: d)
        updater = u
        do { try u.start() } catch {
            log("start failed: \(error.localizedDescription)")
            dispatch(.failed(stage: .check, reason: "Updates aren’t available in this copy of Squeak.", userInitiated: true))
            return
        }
        observation = u.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, change in
            let value = change.newValue ?? false
            Task { @MainActor in self?.canCheckChanged(value) }
        }
        log("Sparkle started: version \(AppModel.appVersion), checks=\(u.automaticallyChecksForUpdates), automaticDownloads=\(u.automaticallyDownloadsUpdates), interval=\(Int(u.updateCheckInterval))s")
    }

    private func canCheckChanged(_ value: Bool) {
        canCheck = value
        log("canCheckForUpdates=\(value)")
        if value { dispatch(.sparkleBecameIdle) }
    }

    // MARK: What the surfaces call

    /// What Sparkle can take from us right now. `canCheckForUpdates` is read from Sparkle itself, not the KVO copy.
    private var sparkleState: UpdateFlow.SparkleState {
        if userDriver?.updateChoice != nil { return .awaitingChoice }
        return (updater?.canCheckForUpdates ?? false) ? .idle : .busy
    }

    /// "Check for updates…", from the app menu, the popup's menu or Settings. Never silent: it starts a check, attaches
    /// to the one running, or says why it cannot, and ALWAYS opens the update window on the live state (checking,
    /// available, ready to restart, up to date, failed) so every entry point answers in the same place. The popup's
    /// banner and Settings show the same state and buttons from the same flow.
    func checkForUpdates(presenting: Bool = true) {
        log("tap: check (sparkle=\(sparkleState), phase=\(flow.phase))")
        guard updater != nil else {
            dispatch(.failed(stage: .check, reason: "Updates aren’t available in this copy of Squeak.", userInitiated: true))
            if presenting { presentUpdateWindow() }
            return
        }
        dispatch(.checkRequested(sparkle: sparkleState))
        if presenting { presentUpdateWindow() }
    }

    /// The Install button.
    func install() {
        log("tap: install (sparkle=\(sparkleState), phase=\(flow.phase))")
        if informationOnly {
            if let informationURL { NSWorkspace.shared.open(informationURL) }
            return
        }
        guard updater != nil else {
            dispatch(.failed(stage: .check, reason: "Updates aren’t available in this copy of Squeak.", userInitiated: true))
            return
        }
        dispatch(.installRequested(sparkle: sparkleState))
    }

    /// "Restart to update": install the downloaded update now and relaunch.
    func installNow() {
        log("tap: restart (handler=\(installHandler != nil), phase=\(flow.phase))")
        dispatch(.restartRequested(canInstallNow: installHandler != nil))
    }

    func retry() {
        log("tap: try again (sparkle=\(sparkleState), phase=\(flow.phase))")
        dispatch(.retryRequested(sparkle: sparkleState, canInstallNow: installHandler != nil))
    }

    func cancel() {
        log("tap: cancel (phase=\(flow.phase))")
        dispatch(.cancelRequested)
    }

    func dismissStatus() { dispatch(.dismissRequested) }

    /// Download update (after an in-place install was denied) is the same DMG as Download manually.
    func downloadUpdate() { downloadManually() }

    /// System Settings › Privacy & Security › App Management, or the Privacy & Security pane if that anchor fails.
    func openAppManagementSettings() {
        log("tap: open App Management settings")
        NSWorkspace.shared.open(UpdateFlowCopy.appManagementSettingsURL, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
            guard error != nil else { return }
            Task { @MainActor in
                self?.log("App Management anchor did not open; opening Privacy & Security")
                NSWorkspace.shared.open(UpdateFlowCopy.privacySettingsURL)
            }
        }
    }

    /// Whether an in-place install has been refused on this Mac (remembered in UserDefaults).
    var inPlaceInstallDenied: Bool { flow.inPlaceInstallDenied }

    /// Loads the remembered denial at launch, and clears it when an in-place update has worked since.
    func restoreInPlaceDenial(change: VersionChange, marker: UpdateRestoreMarker?, current: String, defaults: UserDefaults = .standard) {
        guard let denial = InPlaceInstallDenial.decode(defaults.data(forKey: InPlaceInstallDenial.defaultsKey)) else { return }
        if denial.clears(change: change, marker: marker, currentVersion: current) {
            defaults.removeObject(forKey: InPlaceInstallDenial.defaultsKey)
            log("launch: version \(current), in-place install worked; forgetting the earlier denial (\(denial.failedVersion ?? "?"))")
            dispatch(.inPlaceDenialRestored(false))
        } else {
            dispatch(.inPlaceDenialRestored(true))
        }
    }

    /// The text the relaunch watchdog captured from the Sparkle installer's log, if it is recent. Removed once read.
    static func takeInstallerReason(at url: URL = UpdateLog.defaultURL.deletingLastPathComponent().appendingPathComponent("installer-reason.txt"), now: Date = Date()) -> String? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let modified = attrs[.modificationDate] as? Date, now.timeIntervalSince(modified) < 600,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        try? FileManager.default.removeItem(at: url)
        return UpdateInstallerReason.pick(from: text)
    }

    func downloadManually() {
        var version = flow.knownVersion
        if case .failed(let f) = flow.phase, let v = f.version { version = v }
        let url = UpdateFlowCopy.manualDownloadURL(version: version)
        log("tap: download manually (\(version ?? "no version"))")
        NSWorkspace.shared.open(url)
    }

    /// Runs a button from `UpdateFlowCopy.actions`.
    func perform(_ action: UpdateFlowCopy.Action) {
        switch action {
        case .install: install()
        case .restart: installNow()
        case .cancel: cancel()
        case .tryAgain: retry()
        case .downloadManually: downloadManually()
        case .downloadUpdate: downloadUpdate()
        case .openAppManagement: openAppManagementSettings()
        case .tryRestartAnyway: installNow()
        case .dismiss: dismissStatus()
        }
    }

    var primaryAction: UpdateFlowCopy.Action? { UpdateFlowCopy.primaryAction(flow.phase, inPlaceDenied: flow.inPlaceInstallDenied) }

    /// The buttons for what is happening now; "Cancel" only when Sparkle gave us a way to cancel.
    var actions: [UpdateFlowCopy.Action] {
        UpdateFlowCopy.actions(flow.phase, inPlaceDenied: flow.inPlaceInstallDenied).filter { $0 != .cancel || cancellable }
    }

    /// The app reopened on the version it had before "Restart to update".
    func restartDidNotApply(target: String?, running: String, defaults: UserDefaults = .standard) {
        let reason = Self.takeInstallerReason()
        log("launch: restart did not apply (running \(running), target \(target ?? "unknown"), installer reason: \(reason ?? "not captured yet"))")
        dispatch(.restartDidNotApply(target: target, running: running, installerReason: reason))
        remember(denialFor: target, running: running, reason: reason, defaults: defaults)
        guard reason == nil else { return }
        // The watchdog reads the installer's log a few seconds after it reopens the app: pick the reason up when it lands.
        Task { @MainActor [weak self] in
            for _ in 0..<12 {
                try? await Task.sleep(for: .seconds(3))
                guard let self else { return }
                if let late = Self.takeInstallerReason() {
                    self.log("installer reason arrived: \(late)")
                    self.dispatch(.installerReasonArrived(target: target, running: running, reason: late))
                    self.remember(denialFor: target, running: running, reason: late, defaults: defaults)
                    return
                }
            }
        }
    }

    private func remember(denialFor target: String?, running: String, reason: String?, defaults: UserDefaults) {
        guard flow.inPlaceInstallDenied else { return }
        defaults.set(InPlaceInstallDenial(failedVersion: target, runningVersion: running).encoded(), forKey: InPlaceInstallDenial.defaultsKey)
    }

    // MARK: Flow

    func dispatch(_ event: UpdateFlow.Event) {
        let before = flow.phase
        let commands = flow.handle(event, now: Date())
        record(event, from: before)
        for command in commands { perform(command) }
        scheduleTick()
        if flow.phase == .idle, permissionAction == nil, updateWindow != nil, !windowPinned { closeUpdateWindow() }
        updateWindow?.resize(for: presentation)
        onChange?()
    }

    private func record(_ event: UpdateFlow.Event, from before: UpdateFlow.Phase) {
        switch event {
        case .downloadProgress, .extractProgress, .tick:
            if before.description != flow.phase.description { log("phase \(before) -> \(flow.phase)") }
        default:
            log("event \(event) | phase \(before) -> \(flow.phase)")
        }
    }

    private func perform(_ command: UpdateFlow.Command) {
        log("command \(command)")
        switch command {
        case .startCheck:
            guard let updater, updater.canCheckForUpdates else {
                log("check not started: Sparkle is busy or not started")
                dispatch(.failed(stage: .check, reason: UpdateFlowCopy.cantStart, userInitiated: true))
                return
            }
            updater.checkForUpdates()
        case .acceptUpdate:
            if let choice = userDriver?.updateChoice {
                userDriver?.updateChoice = nil
                choice(.install)
            } else {
                acceptOnOffer = true
            }
        case .installNow:
            QuitIntent.shared.beginUserRestart()
            if let installHandler {
                installHandler()
            } else {
                log("installer handler missing at restart")
                QuitIntent.shared.endUpdateAttempt()
                dispatch(.failed(stage: .install, reason: UpdateFlowCopy.installerGone, userInitiated: true))
            }
        case .cancelSession:
            acceptOnOffer = false
            userDriver?.cancelCurrent?()
            if let choice = userDriver?.updateChoice { userDriver?.updateChoice = nil; choice(.dismiss) }
        case .endAttempt:
            acceptOnOffer = false
            QuitIntent.shared.endUpdateAttempt()
        }
    }

    /// One tick a second while a phase has a deadline, so a hung session always ends.
    private func scheduleTick() {
        guard flow.deadline != nil else { tickTask?.cancel(); tickTask = nil; return }
        guard tickTask == nil else { return }
        tickTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                if self.flow.deadline == nil { self.tickTask = nil; return }
                self.dispatch(.tick)
            }
        }
    }

    fileprivate func log(_ line: String) {
        updateLog.write(line)
        AppLog.info("updates: \(line)")
    }

    // MARK: Window (explicit "Check for updates…", the permission prompt, Sparkle asking for focus)

    /// A window the person asked for stays until they press Done, even once the flow is idle.
    @ObservationIgnored private var windowPinned = false

    func presentUpdateWindow() {
        if updateWindow == nil { updateWindow = UpdateWindowController(owner: self) }
        windowPinned = true
        updateWindow?.resize(for: presentation)
        updateWindow?.present()
    }

    fileprivate func closeUpdateWindow() {
        windowPinned = false
        updateWindow?.close(); updateWindow = nil
    }

    fileprivate func respondToPermission(_ allow: Bool) {
        permissionAction?(allow); permissionAction = nil
        log("permission: \(allow ? "allowed" : "declined")")
        closeUpdateWindow()
    }

    /// "Later": hand the offered update back to Sparkle (it can offer it again) and close.
    fileprivate func later() {
        if let choice = userDriver?.updateChoice { userDriver?.updateChoice = nil; choice(.dismiss) }
        closeUpdateWindow()
    }

    fileprivate func closeUpdateWindowOnly() { closeUpdateWindow() }
    /// "Skip This Version" needs Sparkle's pending offer to answer.
    var canSkip: Bool { userDriver?.updateChoice != nil }

    fileprivate func skipVersion() {
        if let choice = userDriver?.updateChoice { userDriver?.updateChoice = nil; choice(.skip) }
        closeUpdateWindow()
    }

    // MARK: What the window says

    var presentation: UpdatePresentationState {
        if permissionAction != nil { return .permission }
        switch flow.phase {
        // The window is open and nothing is pending (a check that found nothing ends here): that is "up to date",
        // not an empty card.
        case .idle: return .current
        case .checking: return .checking
        case .available: return .available
        case .downloading: return .downloading
        case .extracting, .installing, .relaunching: return .installing
        case .readyToInstall: return .ready
        case .failed: return .error
        case .upToDate: return .current
        }
    }

    var statusTitle: String {
        if permissionAction != nil { return "Keep Squeak up to date?" }
        switch flow.phase {
        case .idle: return "You’re up to date"
        case .checking: return "Checking for updates"
        case .available(let v): return "Squeak \(v) is available"
        case .downloading: return "Downloading update"
        case .extracting: return "Preparing update"
        case .readyToInstall: return "Update is ready"
        case .installing: return "Installing update"
        case .relaunching: return "Restarting Squeak"
        case .failed: return "Update couldn’t finish"
        case .upToDate: return "You’re up to date"
        }
    }

    var statusDetail: String {
        if permissionAction != nil { return "Squeak can check for updates and download them in the background. You can change this any time in Settings." }
        switch flow.phase {
        case .idle: return "Squeak \(AppModel.appVersion) is the latest version."
        case .checking: return "Looking for the latest version of Squeak."
        case .available: return availableNotes.first ?? (informationOnly ? "Read about this version." : "A newer version is available.")
        case .downloading(_, let p): return p.map { "\(Int(($0 * 100).rounded()))% downloaded" } ?? "Downloading a verified update."
        case .extracting: return "Verifying and unpacking Squeak."
        case .readyToInstall: return flow.inPlaceInstallDenied ? "\(UpdateFlowCopy.inPlaceBlockedNote) Download the update and drag Squeak to Applications, or try restarting anyway." : "Squeak will restart to finish installing."
        case .installing: return retryInstallation == nil ? "Squeak will reopen when the update is complete." : "Squeak needs to close before the update can finish."
        case .relaunching: return "Squeak will reopen when the update is complete."
        case .failed(let f): return f.reason
        case .upToDate: return "Squeak \(AppModel.appVersion) is the latest version."
        }
    }

    var progress: Double? { UpdateFlowCopy.progress(flow.phase) }

    // MARK: Called by the delegate and the driver (main thread)

    fileprivate func found(_ version: String?, notes: [String]) {
        let changed = version != availableVersion
        availableVersion = version
        if !notes.isEmpty || changed { availableNotes = notes }
        onChange?()
    }
    fileprivate func cleared(skipped: String? = nil) {
        if let skipped { skippedVersion = skipped }
        availableVersion = nil; readyVersion = nil; availableNotes = []; readyNotes = []; installHandler = nil
        informationOnly = false; informationURL = nil
        onChange?()
    }
    fileprivate func ready(_ version: String?, notes: [String], handler: @escaping () -> Void) {
        readyVersion = version
        readyNotes = notes
        installHandler = handler
        acceptOnOffer = false
        dispatch(.staged(version: version ?? flow.knownVersion ?? "update"))
    }
    /// The session is over for good: its installer block is dead, so a press on "Restart" must not call it.
    fileprivate func sessionOver() {
        installHandler = nil; retryInstallation = nil; cancellable = false; acceptOnOffer = false
    }
    fileprivate func setCancellable(_ value: Bool) { if cancellable != value { cancellable = value } }
    fileprivate func showWindowInFocus() { presentUpdateWindow() }
    fileprivate func offerPermission(_ reply: @escaping (Bool) -> Void) {
        permissionAction = reply
        presentUpdateWindow()
        onChange?()
    }
    fileprivate func setRetryInstallation(_ retry: (() -> Void)?) { retryInstallation = retry }
}

/// Sparkle ends an install by terminating the app without a `quit` Apple event, so it says so
/// first: that termination must be a real one (see `QuitPolicy`), or Sparkle could not relaunch us.
/// Set synchronously: Sparkle calls these on the main thread and may terminate right after, so a
/// `Task` would run too late, and its own update window would count as an open window to close.
final class UpdateDelegate: NSObject, SPUUpdaterDelegate {
    private weak var owner: AppUpdater?

    init(owner: AppUpdater) { self.owner = owner }

    private func onMain(_ body: @escaping @MainActor () -> Void) {
        if Thread.isMainThread { MainActor.assumeIsolated(body) } else { DispatchQueue.main.sync { MainActor.assumeIsolated(body) } }
    }

    private func note(_ line: String) { onMain { self.owner?.log("sparkle: \(line)") } }

    // MARK: Quit must succeed

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        onMain {
            self.owner?.log("sparkle: willInstallUpdate \(version)")
            QuitIntent.shared.beginUpdateQuit()
            self.owner?.dispatch(.installBegan)
        }
    }

    /// Sparkle installing on a quit the person chose must not reopen the app.
    func updaterShouldRelaunchApplication(_ updater: SPUUpdater) -> Bool {
        var relaunch = true
        onMain {
            relaunch = QuitPolicy.shouldRelaunchAfterUpdate(explicitQuit: QuitIntent.shared.explicitQuit, userQuit: QuitIntent.shared.userQuit)
            self.owner?.log("sparkle: shouldRelaunchApplication -> \(relaunch)")
        }
        return relaunch
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        onMain {
            self.owner?.log("sparkle: willRelaunchApplication")
            QuitIntent.shared.beginUpdateQuit()
            self.owner?.dispatch(.willRelaunch)
        }
    }

    /// The download is staged and installs on the next real quit. Nothing here holds Sparkle back,
    /// and the installer stays reachable from the panel ("Restart to update").
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        let version = item.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: item.itemDescription)
        onMain {
            self.owner?.log("sparkle: willInstallUpdateOnQuit \(version)")
            QuitIntent.shared.installPending = true
            self.owner?.ready(version, notes: notes, handler: immediateInstallHandler)
        }
        return true
    }

    /// A failed install must not leave the quit flag armed (the next Cmd-Q would quit instead of closing windows).
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let ns = error as NSError
        let benign = ns.domain == SUSparkleErrorDomain && (ns.code == Int(SUError.noUpdateError.rawValue) || ns.code == Int(SUError.installationCanceledError.rawValue))
        onMain {
            self.owner?.log("sparkle: didAbortWithError domain=\(ns.domain) code=\(ns.code) \(error.localizedDescription)\(benign ? " (not a failure)" : "")")
            guard !benign else { return }
            QuitIntent.shared.endUpdateAttempt()
            self.owner?.sessionOver()
            let stage = self.owner?.flow.phase.failureStage ?? .check
            self.owner?.dispatch(.failed(stage: stage, reason: UpdateFlowCopy.failureReason(stage, offline: Self.isOffline(error)), userInitiated: false))
        }
    }

    static func isOffline(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        return [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorTimedOut, NSURLErrorDNSLookupFailed].contains(ns.code)
    }

    // MARK: What the panel shows

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: item.itemDescription)
        onMain {
            self.owner?.log("sparkle: didFindValidUpdate \(version) (build \(item.versionString))")
            self.owner?.found(version, notes: notes)
            self.owner?.dispatch(.updateFound(version: version))
        }
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        onMain {
            self.owner?.log("sparkle: didNotFindUpdate")
            self.owner?.cleared()
            self.owner?.dispatch(.noUpdate)
        }
    }

    func updater(_ updater: SPUUpdater, didFinishLoading appcast: SUAppcast) { note("appcast loaded, \(appcast.items.count) items") }

    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate updateItem: SUAppcastItem, state: SPUUserUpdateState) {
        let version = updateItem.displayVersionString
        let name = choice == .skip ? "skip" : (choice == .install ? "install" : "dismiss")
        onMain {
            self.owner?.log("sparkle: userDidMakeChoice \(name) \(version) (stage \(state.stage.rawValue), userInitiated \(state.userInitiated))")
            if choice == .skip {
                self.owner?.cleared(skipped: version)
                self.owner?.dispatch(.skipped)
            }
        }
    }

    // MARK: Progress that user-driver callbacks never see (automatic sessions)

    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        let version = item.displayVersionString
        onMain {
            self.owner?.log("sparkle: willDownloadUpdate \(version)")
            self.owner?.dispatch(.downloadBegan(version: version))
        }
    }

    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) { note("didDownloadUpdate \(item.displayVersionString)") }

    func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: Error) {
        let version = item.displayVersionString
        let ns = error as NSError
        onMain {
            self.owner?.log("sparkle: failedToDownloadUpdate \(version) domain=\(ns.domain) code=\(ns.code) \(error.localizedDescription)")
            self.owner?.dispatch(.failed(stage: .download, reason: UpdateFlowCopy.failureReason(.download, offline: Self.isOffline(error)), userInitiated: false))
        }
    }

    func userDidCancelDownload(_ updater: SPUUpdater) {
        onMain {
            self.owner?.log("sparkle: userDidCancelDownload")
            self.owner?.dispatch(.canceledByUser)
        }
    }

    func updater(_ updater: SPUUpdater, willExtractUpdate item: SUAppcastItem) {
        onMain {
            self.owner?.log("sparkle: willExtractUpdate \(item.displayVersionString)")
            self.owner?.dispatch(.extractBegan)
        }
    }

    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) { note("didExtractUpdate \(item.displayVersionString)") }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        let kind = updateCheck == .updates ? "user check" : (updateCheck == .updatesInBackground ? "background check" : "information check")
        note("didFinishUpdateCycle (\(kind))\(error.map { ", error: \($0.localizedDescription)" } ?? "")")
    }

    func updater(_ updater: SPUUpdater, willScheduleUpdateCheckAfterDelay delay: TimeInterval) { note("next scheduled check in \(Int(delay)) s") }

    func updaterWillNotScheduleUpdateCheck(_ updater: SPUUpdater) { note("no further check scheduled") }
}

enum UpdatePresentationState: Equatable { case idle, permission, checking, available, ready, downloading, installing, error, current }

/// Sparkle calls this for every user-facing update step. The UI owns the replies; Sparkle still
/// owns appcast validation, EdDSA/archive signature checks, staging, authorization, and installation.
/// Every step goes into the flow whether or not a person started the session.
@MainActor
final class UpdateUserDriver: NSObject, SPUUserDriver {
    weak var owner: AppUpdater?
    var cancelCurrent: (() -> Void)? { didSet { owner?.setCancellable(cancelCurrent != nil) } }
    var updateChoice: ((SPUUserUpdateChoice) -> Void)?
    private var expected: UInt64 = 0
    private var received: UInt64 = 0
    private var lastPercent = -1
    private var lastActivity = Date.distantPast
    private var lastExtractPercent = -1
    init(owner: AppUpdater) { self.owner = owner }

    private func log(_ line: String) { owner?.log("driver: \(line)") }

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        log("permission request")
        guard let owner else {
            reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, automaticUpdateDownloading: NSNumber(value: false), sendSystemProfile: false))
            return
        }
        owner.offerPermission { [weak owner] allow in
            let checks = allow
            reply(SUUpdatePermissionResponse(automaticUpdateChecks: checks, automaticUpdateDownloading: NSNumber(value: checks && (owner?.automaticallyInstalls ?? true)), sendSystemProfile: false))
        }
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        log("user-initiated check")
        cancelCurrent = cancellation
        owner?.dispatch(.checkBegan(userInitiated: true))
    }
    func showUpdateFound(with item: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        cancelCurrent = nil
        guard let owner else { reply(.dismiss); return }
        let version = item.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: item.itemDescription)
        log("update found \(version) (userInitiated \(state.userInitiated), stage \(state.stage.rawValue), infoOnly \(item.isInformationOnlyUpdate))")
        owner.found(version, notes: notes)
        owner.informationOnly = item.isInformationOnlyUpdate
        owner.informationURL = item.infoURL
        owner.dispatch(.updateFound(version: version))
        // The person already pressed Install (it waited for this offer): say yes now.
        if owner.acceptOnOffer, !item.isInformationOnlyUpdate {
            owner.acceptOnOffer = false
            log("accepting the offered update: the person asked for it")
            reply(.install)
            return
        }
        // A scheduled check only updates the app's quiet banner and gives the offer back; Sparkle's modal is never used.
        guard state.userInitiated else { reply(.dismiss); return }
        // A person's check: hold the offer until they press Install (banner, Settings or the update window).
        updateChoice = reply
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        guard let html = String(data: downloadData.data, encoding: .utf8) else { return }
        let notes = ReleaseNotes.bullets(fromHTML: html)
        if !notes.isEmpty { owner?.availableNotes = notes }
    }
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
        log("release notes failed: \(error.localizedDescription)")
    }
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        log("no update found: \(error.localizedDescription)")
        // Acknowledge at once: Sparkle's session stays open (and every later press is a no-op) until this is called.
        acknowledgement()
        owner?.cleared()
        owner?.dispatch(.noUpdate)
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        let ns = error as NSError
        log("error: domain=\(ns.domain) code=\(ns.code) \(error.localizedDescription) \(ns.localizedRecoverySuggestion ?? "")")
        acknowledgement()
        let stage = owner?.flow.phase.failureStage ?? .check
        owner?.sessionOver()
        owner?.dispatch(.failed(stage: stage, reason: UpdateFlowCopy.failureReason(stage, offline: UpdateDelegate.isOffline(error)), userInitiated: true))
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        cancelCurrent = cancellation; expected = 0; received = 0; lastPercent = -1
        log("download initiated")
        owner?.dispatch(.downloadBegan(version: nil))
    }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        expected = expectedContentLength
        log("download size \(expectedContentLength) bytes")
        updateDownloadProgress()
    }
    func showDownloadDidReceiveData(ofLength length: UInt64) {
        received += length
        // The stall clock follows any data at all, not only a new percent: a slow link can sit on one percent for a while.
        let now = Date()
        if now.timeIntervalSince(lastActivity) >= 2 { lastActivity = now; owner?.dispatch(.downloadActivity) }
        updateDownloadProgress()
    }
    private func updateDownloadProgress() {
        let value = expected > 0 ? min(1, Double(received) / Double(expected)) : nil
        let percent = value.map { Int($0 * 100) } ?? -1
        // A progress event per data chunk would redraw the banner hundreds of times a second.
        guard percent != lastPercent else { return }
        lastPercent = percent
        owner?.dispatch(.downloadProgress(value))
    }
    func showDownloadDidStartExtractingUpdate() {
        cancelCurrent = nil; lastExtractPercent = -1
        log("extraction started")
        owner?.dispatch(.extractBegan)
    }
    func showExtractionReceivedProgress(_ progress: Double) {
        let percent = Int(progress * 100)
        guard percent != lastExtractPercent else { return }
        lastExtractPercent = percent
        owner?.dispatch(.extractProgress(progress))
    }
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        log("ready to install and relaunch")
        // Hold the reply: "Restart to update" answers it. Replying here would restart the app the moment
        // the download ends, and dismissing would leave the person with no way to restart from the banner.
        guard let owner else { reply(.dismiss); return }
        let version = owner.flow.knownVersion ?? owner.availableVersion
        owner.ready(version, notes: owner.availableNotes, handler: { reply(.install) })
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        log("installing (applicationTerminated \(applicationTerminated))")
        owner?.setRetryInstallation(applicationTerminated ? nil : retryTerminatingApplication)
        owner?.dispatch(.installBegan)
    }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        log("installed (relaunched \(relaunched))")
        acknowledgement()
        owner?.dispatch(.installed)
    }
    func dismissUpdateInstallation() {
        log("session dismissed")
        cancelCurrent = nil; updateChoice = nil
        owner?.setRetryInstallation(nil)
    }
    func showUpdateInFocus() {
        log("show update in focus")
        owner?.showWindowInFocus()
    }
}

@MainActor
final class UpdateWindowController {
    private let window: NSWindow
    init(owner: AppUpdater) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: UpdateStatusView.height(for: owner.presentation)), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Squeak Update"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor.windowBackgroundColor
        window.isReleasedWhenClosed = false
        // Every visible state has an explicit action that replies to Sparkle. A close button
        // could otherwise dismiss the window while Sparkle waits on a permission/acknowledgement.
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.contentView = NSHostingView(rootView: UpdateStatusView(owner: owner))
    }
    /// Brings the window to the front. Squeak is an accessory app: like every other window it first asks for the
    /// regular activation policy (`willShowWindow`), or macOS 14+ may ignore the activation and the window opens
    /// behind whatever is in front, which reads as "nothing happened".
    func present() {
        ActivationPolicyController.shared.willShowWindow()
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }
    func resize(for state: UpdatePresentationState) {
        let size = NSSize(width: 480, height: UpdateStatusView.height(for: state))
        guard window.contentView?.frame.size != size else { return }
        window.setContentSize(size)
    }
    func close() { window.close() }
}

/// A little release card: the duck carries the warmth; the release and controls stay precise.
private struct UpdateStatusView: View {
    let owner: AppUpdater
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var artworkMotion = false

    static func height(for state: UpdatePresentationState) -> CGFloat { state == .available ? 560 : 440 }

    private var busy: Bool {
        owner.presentation == .checking || owner.presentation == .downloading || owner.presentation == .installing
    }
    private var stateLabel: String {
        switch owner.presentation {
        case .available: "NEW RELEASE"
        case .permission: "STAY UP TO DATE"
        case .checking: "CHECKING FOR UPDATES"
        case .downloading: "DOWNLOADING"
        case .installing: "GETTING READY"
        case .current: "ALL UP TO DATE"
        case .ready: "READY TO INSTALL"
        case .error: "UPDATE PAUSED"
        case .idle: "SQUEAK FOR MAC"
        }
    }
    private var stateSymbol: String {
        switch owner.presentation {
        case .current: "checkmark"
        case .error: "exclamationmark"
        case .permission: "arrow.triangle.2.circlepath"
        default: "arrow.down"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            illustration
            VStack(alignment: .leading, spacing: 12) {
                Text(stateLabel)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(1.6)
                    .foregroundStyle(Theme.muted)
                Text(owner.statusTitle)
                    .font(.system(size: 26, weight: .semibold))
                    .tracking(-0.7)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if owner.presentation == .available, let version = owner.availableVersion {
                    HStack(spacing: 10) {
                        Text(AppModel.appVersion).foregroundStyle(Theme.muted)
                        Image(systemName: "arrow.right").font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.subtle)
                        Text(version).foregroundStyle(Theme.ink)
                    }
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Version \(AppModel.appVersion) to \(version)")
                }
                // Release notes already contain the first bullet; do not repeat it above the list.
                if owner.presentation != .available || owner.availableNotes.isEmpty {
                    ScrollView {
                        Text(owner.statusDetail)
                            .font(Typo.body).foregroundStyle(Theme.muted)
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: owner.presentation == .error ? 110 : 60)
                } else {
                    releaseNotes
                }
                if busy { progress }
            }
            .padding(.horizontal, 32)
            .padding(.top, 10)
            Spacer(minLength: 20)
            footer
        }
        .frame(width: 480, height: Self.height(for: owner.presentation))
        .background(Theme.surface)
        .accessibilityElement(children: .contain)
    }

    private var illustration: some View {
        ZStack {
            // A quiet pond around the original, unmodified brand artwork. The motion stays
            // decorative and stops when Reduce Motion is enabled.
            ForEach([140.0, 210.0, 280.0], id: \.self) { width in
                Ellipse()
                    .stroke(Theme.lineStrong.opacity(artworkMotion && !reduceMotion ? 0.72 : 1), lineWidth: 1)
                    .frame(width: width, height: width * 0.08)
                    .offset(y: artworkMotion && !reduceMotion ? 78 : 84)
            }
            Circle()
                .fill(Theme.duck.opacity(artworkMotion && !reduceMotion ? 0.14 : 0.09))
                .frame(width: 152, height: 152)
                .scaleEffect(artworkMotion && !reduceMotion ? 1.04 : 0.98)
            DuckMark(width: 108)
                .offset(y: artworkMotion && !reduceMotion ? -12 : -4)
                .rotationEffect(.degrees(artworkMotion && !reduceMotion ? -1.5 : 1.5))
            Image(systemName: stateSymbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(owner.presentation == .error ? Theme.error : Theme.ink)
                .frame(width: 32, height: 32)
                .background(Theme.surfaceRaised, in: Circle())
                .overlay(Circle().strokeBorder(Theme.duck.opacity(artworkMotion && !reduceMotion ? 0.52 : 0.22)))
                .offset(x: 96, y: -24)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 190)
        .accessibilityHidden(true)
        .animation(reduceMotion ? nil : .easeInOut(duration: 3.0).repeatForever(autoreverses: true), value: artworkMotion)
        .onAppear { artworkMotion = !reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in artworkMotion = !reduced }
    }

    private var uniqueNotes: [String] {
        var seen = Set<String>()
        return owner.availableNotes.filter { seen.insert($0).inserted }
    }

    private var releaseNotes: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What’s new").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(uniqueNotes, id: \.self) { note in
                        HStack(alignment: .firstTextBaseline, spacing: 9) {
                            Circle().fill(Theme.subtle).frame(width: 4, height: 4).offset(y: -2)
                            Text(note).font(Typo.body).foregroundStyle(Theme.muted)
                                .lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(.trailing, 8)
            }
            .frame(maxHeight: 112)
        }
        .padding(16)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line))
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let value = owner.progress {
                ProgressView(value: value).tint(Theme.primaryFill)
                    .accessibilityLabel("Update progress")
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(owner.presentation == .checking ? "Looking for a newer version" : "This may take a moment")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(.top, 8)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 8) {
                actions
            }
            .padding(.horizontal, 24).padding(.vertical, 20)
        }
    }

    @ViewBuilder private var actions: some View {
        switch owner.presentation {
        case .permission:
            Button("Not now") { owner.respondToPermission(false) }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("Enable Updates") { owner.respondToPermission(true) }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        case .available where owner.informationOnly:
            Button("Later") { owner.later() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("View Details") { owner.install(); owner.later() }
                .buttonStyle(UpdatePrimaryButtonStyle()).disabled(owner.informationURL == nil).keyboardShortcut(.defaultAction)
        case .available where owner.inPlaceInstallDenied:
            Button("Later") { owner.later() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("Install") { owner.install() }.buttonStyle(SecondaryButtonStyle())
            Button("Download update") { owner.downloadUpdate() }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        case .available:
            Menu {
                Button("Skip This Version") { owner.skipVersion() }.disabled(!owner.canSkip)
            } label: {
                Image(systemName: "ellipsis").frame(width: 26, height: 26).accessibilityLabel("More update options")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            Spacer()
            Button("Later") { owner.later() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            Button("Install") { owner.install() }
                .buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        case .ready where owner.inPlaceInstallDenied:
            Button("Later") { owner.closeUpdateWindowOnly() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("Try restart anyway") { owner.installNow() }.buttonStyle(SecondaryButtonStyle())
            Button("Download update") { owner.downloadUpdate() }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        case .ready:
            Button("Later") { owner.closeUpdateWindowOnly() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("Restart to update") { owner.installNow() }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        case .downloading, .checking:
            Text("Squeak for Mac · \(AppModel.appVersion)").font(Typo.meta).foregroundStyle(Theme.subtle)
            Spacer()
            if owner.actions.contains(.cancel) {
                Button("Cancel") { owner.cancel() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            }
            Button("Hide") { owner.closeUpdateWindowOnly() }.buttonStyle(SecondaryButtonStyle())
        case .installing:
            Text("Squeak will reopen when it’s ready.").font(Typo.meta).foregroundStyle(Theme.muted)
            Spacer()
            if owner.retryInstallation != nil {
                Button("Try Again") { owner.retryInstallation?() }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            } else {
                Button("Hide") { owner.closeUpdateWindowOnly() }.buttonStyle(SecondaryButtonStyle())
            }
        case .error:
            Button("Done") { owner.dismissStatus(); owner.closeUpdateWindowOnly() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            ForEach(owner.actions.filter { $0 != .dismiss }, id: \.self) { action in
                if action == owner.primaryAction {
                    Button(UpdateFlowCopy.label(action)) { owner.perform(action) }
                        .buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                } else {
                    Button(UpdateFlowCopy.label(action)) { owner.perform(action) }.buttonStyle(SecondaryButtonStyle())
                }
            }
        case .current, .idle:
            Text("Squeak for Mac · \(AppModel.appVersion)").font(Typo.meta).foregroundStyle(Theme.subtle)
            Spacer()
            Button("Done") { owner.dismissStatus(); owner.closeUpdateWindowOnly() }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        }
    }
}

private struct UpdatePrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.label)
            .foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
            .padding(.horizontal, 16)
            .frame(height: 34)
            .background(isEnabled ? (configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill) : Theme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(isEnabled ? Color.clear : Theme.line))
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

// Uses the same views and window chrome, with no live updater or install callbacks.
extension AppUpdater {
    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=update: every update state, in both appearances.
    static func captureUpdateUI(prefix: String) async {
        let notes = [
            "See which agents need you, straight from the menu bar.",
            "Keep your place when switching between conversations.",
            "More reliable replies when your Mac reconnects.",
            "Updates download quietly and are ready on your next restart.",
        ]
        let states: [(String, [UpdateFlow.Event], Bool)] = [
            ("available", [.updateFound(version: "2.12.0")], false),
            ("permission", [], true),
            ("checking", [.checkBegan(userInitiated: true), .checkRequested(sparkle: .idle)], false),
            ("downloading", [.updateFound(version: "2.12.0"), .downloadBegan(version: "2.12.0"), .downloadProgress(0.64)], false),
            ("installing", [.updateFound(version: "2.12.0"), .extractBegan], false),
            ("ready", [.staged(version: "2.12.0")], false),
            ("current", [.checkRequested(sparkle: .idle), .noUpdate], false),
            ("error", [.updateFound(version: "2.12.0"), .downloadBegan(version: "2.12.0"),
                       .failed(stage: .download, reason: UpdateFlowCopy.failureReason(.download, offline: true), userInitiated: true)], false),
        ]
        for (tone, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for (name, events, permission) in states {
                let owner = AppUpdater()
                owner.userDriver = UpdateUserDriver(owner: owner)
                owner.found("2.12.0", notes: notes)
                for e in events { owner.flow.handle(e, now: Date()) }
                if permission { owner.permissionAction = { _ in } }
                let state = owner.presentation
                let host = NSHostingView(rootView: UpdateStatusView(owner: owner))
                host.appearance = NSAppearance(named: appearance)
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: UpdateStatusView.height(for: state)),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = host
                window.makeKeyAndOrderFront(nil)
                try? await Task.sleep(for: .milliseconds(150))
                CaptureRunner.write(host, to: "\(prefix)-\(name)-\(tone).png")
                window.orderOut(nil)
            }
        }
        QuitIntent.shared.quitCompletely()
    }
}
