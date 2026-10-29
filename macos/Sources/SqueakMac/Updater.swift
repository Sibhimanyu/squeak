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
    private(set) var presentation = UpdatePresentationState.idle
    fileprivate var permissionAction: ((Bool) -> Void)?
    fileprivate var acknowledgementAction: (() -> Void)?
    fileprivate var retryInstallation: (() -> Void)?
    fileprivate var applicationTerminated = false
    private(set) var progress: Double?
    private(set) var statusTitle = "Squeak Update"
    private(set) var statusDetail = ""
    fileprivate(set) var informationOnly = false
    fileprivate(set) var informationURL: URL?
    private(set) var updateWindow: UpdateWindowController?
    /// Version string of an update Sparkle found and that is not installed yet.
    private(set) var availableVersion: String?
    /// Version of an update already downloaded and waiting to install when the app quits.
    private(set) var readyVersion: String?
    /// What changed in those versions, as plain bullets (empty when the appcast item has none).
    fileprivate(set) var availableNotes: [String] = []
    private(set) var readyNotes: [String] = []
    @ObservationIgnored private var updater: SPUUpdater?
    @ObservationIgnored private var observation: NSKeyValueObservation?
    @ObservationIgnored private var userDriver: UpdateUserDriver?
    @ObservationIgnored private var delegate: UpdateDelegate?
    @ObservationIgnored fileprivate var installHandler: (() -> Void)?
    /// Told after every change to what is found or ready, so the model can badge and notify.
    @ObservationIgnored var onChange: (() -> Void)?
    /// Version the person chose to skip (Sparkle also remembers it); never notified about.
    @ObservationIgnored fileprivate(set) var skippedVersion: String?

    /// Capture and demo only (`SQUEAK_MAC_DEMO_UPDATE`): shows an update with no Sparkle behind it.
    func demoFound(_ version: String, notes: [String]) { found(version, notes: notes) }

    var isActive: Bool { updater != nil }

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
            show(.error, title: "Updates aren’t available", detail: error.localizedDescription)
            return
        }
        observation = u.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, change in
            let value = change.newValue ?? false
            Task { @MainActor in self?.canCheck = value }
        }
        AppLog.info("updates: Sparkle started")
    }

    func checkForUpdates() {
        guard let updater, canCheck else { return }
        progress = nil
        show(.checking, title: "Checking for updates", detail: "Looking for the latest version of Squeak.")
        updater.checkForUpdates()
    }

    fileprivate func show(_ state: UpdatePresentationState, title: String, detail: String, progress: Double? = nil) {
        presentation = state; self.progress = progress
        statusTitle = title; statusDetail = detail
        if updateWindow == nil {
            updateWindow = UpdateWindowController(owner: self)
            updateWindow?.present(focus: true)
        }
    }

    fileprivate func closeUpdateWindow() { updateWindow?.close(); updateWindow = nil }
    fileprivate func cancelUpdate() { userDriver?.cancelCurrent?() }
    fileprivate func respondToPermission(_ allow: Bool) { permissionAction?(allow); permissionAction = nil; closeUpdateWindow() }
    fileprivate func acknowledgeAndClose() {
        let acknowledge = acknowledgementAction
        acknowledgementAction = nil
        acknowledge?()
        closeUpdateWindow()
    }
    fileprivate var installChoice: ((SPUUserUpdateChoice) -> Void)? { get { userDriver?.updateChoice } set { userDriver?.updateChoice = newValue } }


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
        informationOnly = false; informationURL = nil
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
final class UpdateDelegate: NSObject, SPUUpdaterDelegate {
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

}

enum UpdatePresentationState: Equatable { case idle, permission, checking, available, downloading, installing, installed, error, current }

/// Sparkle calls this for every user-facing update step. The UI owns the replies; Sparkle still
/// owns appcast validation, EdDSA/archive signature checks, staging, authorization, and installation.
@MainActor
final class UpdateUserDriver: NSObject, SPUUserDriver {
    weak var owner: AppUpdater?
    var cancelCurrent: (() -> Void)?
    var updateChoice: ((SPUUserUpdateChoice) -> Void)?
    private var expected: UInt64 = 0
    private var received: UInt64 = 0
    private var userInitiatedSession = false
    init(owner: AppUpdater) { self.owner = owner }
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        guard let owner else {
            reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, automaticUpdateDownloading: NSNumber(value: false), sendSystemProfile: false))
            return
        }
        owner.permissionAction = { [weak owner] allow in
            let checks = allow
            reply(SUUpdatePermissionResponse(automaticUpdateChecks: checks, automaticUpdateDownloading: NSNumber(value: checks && (owner?.automaticallyInstalls ?? true)), sendSystemProfile: false))
        }
        owner.show(.permission, title: "Keep Squeak up to date?", detail: "Squeak can check for updates and download them in the background. You can change this any time in Settings.")
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        userInitiatedSession = true
        cancelCurrent = cancellation
        owner?.show(.checking, title: "Checking for updates", detail: "Looking for the latest version of Squeak.")
    }
    func showUpdateFound(with item: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        cancelCurrent = nil
        guard let owner else { reply(.dismiss); return }
        let version = item.displayVersionString
        let notes = ReleaseNotes.bullets(fromHTML: item.itemDescription)
        owner.found(version, notes: notes)
        owner.informationOnly = item.isInformationOnlyUpdate
        owner.informationURL = item.infoURL
        // Scheduled checks update the app's existing quiet banner. Only a person asking to check
        // opens the custom window; Sparkle's modal is never used.
        userInitiatedSession = state.userInitiated
        guard state.userInitiated else { reply(.dismiss); return }
        updateChoice = reply
        owner.show(.available, title: item.isInformationOnlyUpdate ? "Squeak \(version) is available" : "Squeak \(version) is ready", detail: notes.first ?? (item.isInformationOnlyUpdate ? "Read about this version." : "A newer version is available."))
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        guard let html = String(data: downloadData.data, encoding: .utf8) else { return }
        let notes = ReleaseNotes.bullets(fromHTML: html)
        if !notes.isEmpty { owner?.availableNotes = notes }
    }
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
        guard userInitiatedSession else { return }
        owner?.show(.available, title: "Update available", detail: error.localizedDescription)
    }
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        owner?.cleared()
        let reason = error.localizedDescription
        guard let owner else { acknowledgement(); return }
        owner.acknowledgementAction = acknowledgement
        owner.show(.current, title: "You’re up to date", detail: "Squeak \(AppModel.appVersion) is the latest version. \(reason)")
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        guard let owner else { acknowledgement(); return }
        owner.acknowledgementAction = acknowledgement
        let nsError = error as NSError
        let detail = nsError.localizedRecoverySuggestion.map { "\(error.localizedDescription)\n\($0)" } ?? error.localizedDescription
        owner.show(.error, title: "Update couldn’t finish", detail: detail)
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        cancelCurrent = cancellation; expected = 0; received = 0
        guard userInitiatedSession else { return }
        owner?.show(.downloading, title: "Downloading update", detail: "Preparing a verified update.")
    }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expected = expectedContentLength; updateDownloadProgress() }
    func showDownloadDidReceiveData(ofLength length: UInt64) { received += length; updateDownloadProgress() }
    private func updateDownloadProgress() {
        guard userInitiatedSession else { return }
        let value = expected > 0 ? min(1, Double(received) / Double(expected)) : nil
        owner?.show(.downloading, title: "Downloading update", detail: value.map { "\(Int($0 * 100))% downloaded" } ?? "Downloading a verified update.", progress: value)
    }
    func showDownloadDidStartExtractingUpdate() {
        guard userInitiatedSession else { return }
        owner?.show(.installing, title: "Preparing update", detail: "Verifying and unpacking Squeak.")
    }
    func showExtractionReceivedProgress(_ progress: Double) {
        guard userInitiatedSession else { return }
        owner?.show(.installing, title: "Preparing update", detail: "Getting Squeak ready to install.", progress: progress)
    }
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        guard userInitiatedSession else { reply(.dismiss); return }
        updateChoice = reply
        owner?.show(.available, title: "Update is ready", detail: "Squeak will restart to finish installing.")
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        guard userInitiatedSession else { return }
        owner?.applicationTerminated = applicationTerminated
        owner?.retryInstallation = applicationTerminated ? nil : retryTerminatingApplication
        owner?.show(.installing, title: "Installing update", detail: applicationTerminated ? "Squeak will reopen when the update is complete." : "Squeak needs to close before the update can finish.")
    }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        guard userInitiatedSession else { acknowledgement(); return }
        guard let owner else { acknowledgement(); return }
        owner.acknowledgementAction = acknowledgement
        owner.show(.installed, title: "Update installed", detail: relaunched ? "Squeak has reopened with the latest version." : "Squeak is updated and ready to use.")
    }
    func dismissUpdateInstallation() {
        cancelCurrent = nil; updateChoice = nil; userInitiatedSession = false
        owner?.acknowledgementAction = nil; owner?.retryInstallation = nil
        owner?.closeUpdateWindow()
    }
    func showUpdateInFocus() { owner?.updateWindow?.present(focus: true) }
}

@MainActor
final class UpdateWindowController {
    private let window: NSWindow
    init(owner: AppUpdater) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 280), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Squeak Update"
        window.isReleasedWhenClosed = false
        // Every visible state has an explicit action that replies to Sparkle. A close button
        // could otherwise dismiss the window while Sparkle waits on a permission/acknowledgement.
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.contentView = NSHostingView(rootView: UpdateStatusView(owner: owner))
    }
    func present(focus: Bool) {
        if !window.isVisible { window.center(); window.orderFront(nil) }
        guard focus else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func close() { window.close() }
}

private struct UpdateStatusView: View {
    let owner: AppUpdater
    var body: some View {
        VStack(spacing: 14) {
            DuckMark(width: 48)
            Text(title).font(.title3.bold()).multilineTextAlignment(.center)
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(4)
            if owner.presentation == .available { UpdateNotesDisclosure(notes: owner.availableNotes, size: 12).frame(maxWidth: 310) }
            if let progress = owner.progress { ProgressView(value: progress).frame(maxWidth: 260) }
            else if owner.presentation == .checking || owner.presentation == .installing { ProgressView().controlSize(.small) }
            HStack {
                if owner.presentation == .permission {
                    Button("Not now") { owner.respondToPermission(false) }
                    Button("Enable Updates") { owner.respondToPermission(true) }.buttonStyle(.borderedProminent)
                } else if owner.presentation == .available && owner.informationOnly {
                    Button("Later") { owner.installChoice?(.dismiss); owner.installChoice = nil; owner.closeUpdateWindow() }
                    Button("View Details") {
                        if let url = owner.informationURL { NSWorkspace.shared.open(url) }
                        owner.installChoice?(.dismiss); owner.installChoice = nil; owner.closeUpdateWindow()
                    }.buttonStyle(.borderedProminent).disabled(owner.informationURL == nil)
                } else if owner.presentation == .available {
                    Button("Later") { owner.installChoice?(.dismiss); owner.installChoice = nil; owner.closeUpdateWindow() }
                    Button("Skip") { owner.installChoice?(.skip); owner.installChoice = nil; owner.closeUpdateWindow() }
                    Button("Install and Restart") { owner.installChoice?(.install); owner.installChoice = nil }.buttonStyle(.borderedProminent).disabled(owner.installChoice == nil)
                } else if owner.presentation == .downloading {
                    Button("Cancel Download") { owner.cancelUpdate(); owner.closeUpdateWindow() }
                } else if owner.presentation == .checking {
                    Button("Cancel") { owner.cancelUpdate(); owner.closeUpdateWindow() }
                } else if owner.presentation == .installing && owner.retryInstallation != nil {
                    Button("Try Again") { owner.retryInstallation?() }.buttonStyle(.borderedProminent)
                } else if owner.presentation == .current || owner.presentation == .error || owner.presentation == .installed {
                    Button("Done") { owner.acknowledgeAndClose() }.keyboardShortcut(.defaultAction)
                } else { Button("Done") { owner.closeUpdateWindow() }.keyboardShortcut(.defaultAction) }
            }
        }
        .padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
    }
    private var title: String { owner.statusTitle }
    private var detail: String { owner.statusDetail }

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
