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
        updateWindow?.resize(for: state)
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
            QuitIntent.shared.beginUpdateQuit()
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

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { onMain { QuitIntent.shared.beginUpdateQuit() } }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) { onMain { QuitIntent.shared.beginUpdateQuit() } }

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
    func present(focus: Bool) {
        if !window.isVisible { window.center(); window.orderFront(nil) }
        guard focus else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
        case .installed, .current: "ALL UP TO DATE"
        case .error: "UPDATE PAUSED"
        case .idle: "SQUEAK FOR MAC"
        }
    }
    private var stateSymbol: String {
        switch owner.presentation {
        case .installed, .current: "checkmark"
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
        if owner.presentation == .permission {
            Button("Not now") { owner.respondToPermission(false) }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("Enable Updates") { owner.respondToPermission(true) }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        } else if owner.presentation == .available && owner.informationOnly {
            Button("Later") { dismiss() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
            Spacer()
            Button("View Details") {
                if let url = owner.informationURL { NSWorkspace.shared.open(url) }
                dismiss()
            }.buttonStyle(UpdatePrimaryButtonStyle()).disabled(owner.informationURL == nil).keyboardShortcut(.defaultAction)
        } else if owner.presentation == .available {
            Menu {
                Button("Skip This Version") { owner.installChoice?(.skip); owner.installChoice = nil; owner.closeUpdateWindow() }
            } label: {
                Image(systemName: "ellipsis").frame(width: 26, height: 26).accessibilityLabel("More update options")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            Spacer()
            Button("Later") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            Button("Install and Restart") { owner.installChoice?(.install); owner.installChoice = nil }
                .buttonStyle(UpdatePrimaryButtonStyle()).disabled(owner.installChoice == nil).keyboardShortcut(.defaultAction)
        } else if owner.presentation == .downloading || owner.presentation == .checking {
            Text("Squeak for Mac").font(Typo.meta).foregroundStyle(Theme.subtle)
            Spacer()
            Button(owner.presentation == .downloading ? "Cancel Download" : "Cancel") { owner.cancelUpdate(); owner.closeUpdateWindow() }
                .buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
        } else if owner.presentation == .installing {
            Text("Squeak will reopen when it’s ready.").font(Typo.meta).foregroundStyle(Theme.muted)
            Spacer()
            if owner.retryInstallation != nil {
                Button("Try Again") { owner.retryInstallation?() }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        } else {
            Text("Squeak for Mac").font(Typo.meta).foregroundStyle(Theme.subtle)
            Spacer()
            Button("Done") {
                if owner.presentation == .current || owner.presentation == .error || owner.presentation == .installed {
                    owner.acknowledgeAndClose()
                } else { owner.closeUpdateWindow() }
            }.buttonStyle(UpdatePrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        }
    }

    private func dismiss() {
        owner.installChoice?(.dismiss)
        owner.installChoice = nil
        owner.closeUpdateWindow()
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
        let owner = AppUpdater()
        owner.userDriver = UpdateUserDriver(owner: owner)
        owner.installChoice = { _ in }
        owner.demoFound("2.12.0", notes: [
            "See which agents need you, straight from the menu bar.",
            "Keep your place when switching between conversations.",
            "More reliable replies when your Mac reconnects.",
            "Updates download quietly and are ready on your next restart.",
        ])
        let states: [(String, UpdatePresentationState, String, String, Double?)] = [
            ("available", .available, "Squeak 2.12.0 is ready", "A newer version is available.", nil),
            ("permission", .permission, "Keep Squeak up to date?", "Squeak can check for updates and download them in the background. You can change this any time in Settings.", nil),
            ("checking", .checking, "Checking for updates", "Looking for the latest version of Squeak.", nil),
            ("downloading", .downloading, "Downloading update", "64% downloaded", 0.64),
            ("installing", .installing, "Preparing update", "Verifying and unpacking Squeak.", nil),
            ("current", .current, "You’re up to date", "Squeak is the latest version.", nil),
            ("installed", .installed, "Update installed", "Squeak has reopened with the latest version.", nil),
            ("error", .error, "Update couldn’t finish", "The download could not be completed. Check your internet connection and try again.", nil),
        ]
        for (tone, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for (name, state, title, detail, progress) in states {
                owner.show(state, title: title, detail: detail, progress: progress)
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
