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
/// goes in as an event, and the flow's commands come back here to be carried out. The sidebar card (the update UI),
/// the popup banner and Settings all draw the same `flow`; there is no update window.
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
    /// The sidebar card is the only update UI. Told when something needs the person's eye (an explicit check, Sparkle asking
    /// for focus, the permission prompt) so the model can make sure that card is on screen.
    @ObservationIgnored var onNeedsAttention: (() -> Void)?
    /// Bumped to make the card (sidebar footer or Settings) flash and scroll into view.
    private(set) var highlightTick = 0
    @ObservationIgnored private(set) var lastHighlight = Date.distantPast
    func highlightUpdateCard() { highlightTick += 1; lastHighlight = Date() }
    @ObservationIgnored private var retryTask: Task<Void, Never>?
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

    /// "Check for updates…", from any surface. Never silent: it starts a check, attaches to the one running, or says why
    /// it cannot. The result is the sidebar card (`SidebarAppFooter`); there is no update window. `reveal` asks the
    /// model to put that card on screen (menu and panel entries); Settings and the card's own buttons pass false.
    func checkForUpdates(reveal: Bool = false) {
        if reveal { onNeedsAttention?() }
        log("tap: check (sparkle=\(sparkleState), phase=\(flow.phase))")
        guard updater != nil else {
            dispatch(.failed(stage: .check, reason: "Updates aren’t available in this copy of Squeak.", userInitiated: true))
            return
        }
        dispatch(.checkRequested(sparkle: sparkleState))
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
    /// What Install does for the phase now (also what "Install when free" runs once nothing would be lost).
    func installWhenReady() {
        if case .readyToInstall = flow.phase { perform(.restart) } else { perform(.install) }
    }

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
        if denial.isExpired() {
            defaults.removeObject(forKey: InPlaceInstallDenial.defaultsKey)
            log("launch: forgetting an in-place denial older than 24 h (\(denial.failedVersion ?? "?"))")
            dispatch(.inPlaceDenialRestored(false))
        } else if denial.clears(change: change, marker: marker, currentVersion: current) {
            defaults.removeObject(forKey: InPlaceInstallDenial.defaultsKey)
            log("launch: version \(current), in-place install worked; forgetting the earlier denial (\(denial.failedVersion ?? "?"))")
            dispatch(.inPlaceDenialRestored(false))
        } else if denial.isExhausted {
            dispatch(.inPlaceDenialRestored(true, version: denial.failedVersion))
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
        guard url != UpdateFlowCopy.siteURL, let version else { NSWorkspace.shared.open(url); return }
        // Last resort: save the installer to Downloads and show it in Finder; the browser only if that fails.
        Task { @MainActor [weak self] in
            do {
                let (tmp, response) = try await URLSession.shared.download(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
                let dest = downloads.appendingPathComponent("Squeak-\(version).dmg")
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
                self?.log("manual download saved to \(dest.path)")
                NSWorkspace.shared.activateFileViewerSelecting([dest])
            } catch {
                self?.log("manual download failed (\(error.localizedDescription)); opening the browser")
                NSWorkspace.shared.open(url)
            }
        }
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
        case .tryNow: retryTask?.cancel(); retry()
        case .later: retryTask?.cancel(); dismissStatus()
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
        let previous = InPlaceInstallDenial.decode(defaults.data(forKey: InPlaceInstallDenial.defaultsKey))
        let attempts = InPlaceInstallDenial.attemptsAfterFailure(of: target, previous: previous)
        log("launch: restart did not apply (running \(running), target \(target ?? "unknown"), attempt \(attempts), installer reason: \(reason ?? "not captured yet"))")
        dispatch(.restartDidNotApply(target: target, running: running, installerReason: reason, attempts: attempts))
        remember(denialFor: target, running: running, attempts: attempts, defaults: defaults)
        guard reason == nil else { return }
        // The watchdog reads the installer's log a few seconds after it reopens the app: pick the reason up when it lands.
        Task { @MainActor [weak self] in
            for _ in 0..<12 {
                try? await Task.sleep(for: .seconds(3))
                guard let self else { return }
                if let late = Self.takeInstallerReason() {
                    self.log("installer reason arrived: \(late)")
                    self.dispatch(.installerReasonArrived(target: target, running: running, reason: late))
                    // Not a denial after all: nothing to retry or remember.
                    if !UpdateFlowCopy.looksDenied(late) {
                        self.retryTask?.cancel()
                        defaults.removeObject(forKey: InPlaceInstallDenial.defaultsKey)
                    }
                    return
                }
            }
        }
    }

    private func remember(denialFor target: String?, running: String, attempts: Int, defaults: UserDefaults) {
        guard flow.installRetryPending || flow.inPlaceInstallDenied else { return }
        defaults.set(InPlaceInstallDenial(failedVersion: target, runningVersion: running, attempts: attempts).encoded(), forKey: InPlaceInstallDenial.defaultsKey)
    }

    // MARK: Flow

    func dispatch(_ event: UpdateFlow.Event) {
        let before = flow.phase
        let commands = flow.handle(event, now: Date())
        record(event, from: before)
        for command in commands { perform(command) }
        scheduleTick()
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
        case .scheduleRetry(let delay):
            log("download failed; trying again in \(Int(delay)) s (attempt \(flow.autoRetries))")
            retryTask?.cancel()
            retryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled else { return }
                self.dispatch(.autoRetryDue(sparkle: self.sparkleState))
            }
        case .scheduleInstallRetry(let delay):
            log("in-place install denied; trying again in \(Int(delay)) s (attempt \(flow.inPlaceAttempts + 1) of \(InPlaceRetryPlan.maxAttempts))")
            retryTask?.cancel()
            retryTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled else { return }
                self.dispatch(.installRetryDue(sparkle: self.sparkleState, canInstallNow: self.installHandler != nil))
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

    // MARK: Permission prompt (answered inline in the sidebar card)

    func respondToPermission(_ allow: Bool) {
        permissionAction?(allow); permissionAction = nil
        log("permission: \(allow ? "allowed" : "declined")")
        onChange?()
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
    var needsPermission: Bool { permissionAction != nil }
    var canRetryTermination: Bool { retryInstallation != nil }

    func retryTermination() { retryInstallation?() }

    fileprivate func showWindowInFocus() {
        onNeedsAttention?()
    }
    fileprivate func offerPermission(_ reply: @escaping (Bool) -> Void) {
        permissionAction = reply
        onNeedsAttention?()
        onChange?()
    }
    fileprivate func setRetryInstallation(_ retry: (() -> Void)?) { retryInstallation = retry }
}

/// Sparkle ends an install by terminating the app without a `quit` Apple event, so it says so
/// first: that termination must be a real one (see `QuitPolicy`), or Sparkle could not relaunch us.
/// Set synchronously: Sparkle calls these on the main thread and may terminate right after, so a
/// `Task` would run too late.
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
        // A person's check: hold the offer until they press Install (the sidebar card, banner or Settings).
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

// Fixtures for the sidebar card, with no live updater or install callbacks.
extension AppUpdater {
    /// Offline sidebar fixtures also exercise real presentation routing, including Sparkle's late focus callback.
    func demoSidebarState(_ name: String, version: String = "2.18.1") {
        guard ProcessInfo.processInfo.environment["SQUEAK_MAC_DEMO"] == "1" else { return }
        flow = UpdateFlow()
        permissionAction = nil
        retryInstallation = nil
        cancellable = true
        found(version, notes: ["A kanban dashboard for all your streams.", "Updates stay in the sidebar while you work."])
        let events: [UpdateFlow.Event]
        switch name {
        case "checking": events = [.checkBegan(userInitiated: true)]
        case "available": events = [.updateFound(version: version)]
        case "downloading": events = [.downloadBegan(version: version), .downloadProgress(0.64)]
        case "preparing": events = [.downloadBegan(version: version), .extractBegan, .extractProgress(0.4)]
        case "ready": events = [.staged(version: version)]
        case "installing": events = [.staged(version: version), .installBegan]
        case "termination": events = [.staged(version: version), .installBegan]
        case "current": events = [.checkBegan(userInitiated: true), .noUpdate]
        case "error": events = [.failed(stage: .download, reason: "The download stopped. Check your connection and try again.", userInitiated: true)]
        default: events = []
        }
        for event in events { flow.handle(event, now: Date()) }
        if name == "termination" {
            var retried = false
            setRetryInstallation { retried = true }
            precondition(canRetryTermination)
            retryTermination()
            precondition(retried, "Inline termination retry must invoke Sparkle's callback")
        }
        if name == "permission" {
            offerPermission { _ in }
            precondition(needsPermission, "Update consent must remain available inline")
        }
    }

    static func captureSidebarUpdates(prefix: String) async {
        let owner = AppUpdater()
        // Even an unavailable updater must report its failure inline.
        owner.checkForUpdates()
        let states = ["idle", "permission", "checking", "available", "downloading", "preparing", "ready", "installing", "termination", "current", "error"]
        for (tone, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            for state in states {
                owner.demoSidebarState(state)
                let host = NSHostingView(rootView: SidebarAppFooter(updater: owner, version: "2.18.0", openShortcuts: {}, openSettings: {})
                    .frame(width: 256))
                host.appearance = NSAppearance(named: appearance)
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = host
                window.orderFront(nil)
                try? await Task.sleep(for: .milliseconds(150))
                window.setContentSize(host.fittingSize)
                CaptureRunner.write(host, to: "\(prefix)-footer-\(state)-\(tone).png")
                window.orderOut(nil)
            }
        }
        NSApp.terminate(nil)
    }
}
