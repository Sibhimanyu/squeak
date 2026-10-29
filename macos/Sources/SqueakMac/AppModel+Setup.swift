import AppKit
import Foundation
import Observation
import SqueakMacCore

/// The first-run checklist's live facts: the hooks reading, notification permission and Input Monitoring,
/// read again every 3 s while the checklist is on screen. `SetupChecklist` (SqueakMacCore) decides every
/// state and sentence; this only gathers the facts and runs the actions.
@MainActor @Observable
final class SetupModel {
    private(set) var hooks: HooksStatus?
    private(set) var hooksNeedUpdate = false
    private(set) var hooksProblem: String?
    private(set) var hooksBusy = false
    private(set) var notifications: NotificationAccess = .unknown
    private(set) var inputMonitoringOK = false
    /// True once a first reading finished, so the menu does not nag before it knows.
    private(set) var loaded = false
    var conductorSkipped: Bool { didSet { defaults.set(conductorSkipped, forKey: "setupConductorSkipped") } }
    /// What first run remembers across launches: stages passed on or finished, "Get started" and Done.
    var progress: SetupProgress { didSet { save(progress) } }
    /// What is installed on this Mac, read once when setup opens.
    private(set) var detection = AgentDetection()
    /// The Connect screen's button was pressed: run each step in turn, stopping on the first failure.
    var connectRunning = false
    var connectAttempted: Set<ConnectAction> = []
    /// The person pressed the one Welcome button: install the background service as soon as it is known to be missing.
    @ObservationIgnored private var installWhenReady = false

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private let defaults = UserDefaults.standard

    init(client: DaemonClient, demo: Bool) {
        self.client = client
        self.demo = demo
        conductorSkipped = demo ? false : UserDefaults.standard.bool(forKey: "setupConductorSkipped")
        let d = UserDefaults.standard
        progress = demo ? SetupProgress() : SetupProgress(
            skipped: SetupProgress.clean(Set(d.stringArray(forKey: "setupWalkSkipped") ?? [])),
            completed: SetupProgress.clean(Set(d.stringArray(forKey: "setupCompleted") ?? [])),
            started: d.bool(forKey: "setupStarted"), finished: d.bool(forKey: "setupFinished"))
        detection = demo ? AgentDetection(claudeCode: true, codex: true, conductor: true) : Self.detectAgents()
        if demo {
            hooks = DemoData.setupHooks
            notifications = .notDetermined
            inputMonitoringOK = false
            loaded = true
        }
    }

    /// The Welcome button: the person has said yes, so the service is installed by Squeak itself.
    func confirmInstallService() { installWhenReady = true }

    private func save(_ p: SetupProgress) {
        guard !demo else { return }
        defaults.set(Array(p.skipped).sorted(), forKey: "setupWalkSkipped")
        defaults.set(Array(p.completed).sorted(), forKey: "setupCompleted")
        defaults.set(p.started, forKey: "setupStarted")
        defaults.set(p.finished, forKey: "setupFinished")
    }

    /// Quietly: Claude Code, Codex and Conductor on this Mac. A Dock app's PATH is short, so the usual folders are added.
    static func detectAgents() -> AgentDetection {
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", NSHomeDirectory() + "/.local/bin", NSHomeDirectory() + "/.npm-global/bin"]
        return AgentDetection.detect(home: NSHomeDirectory(), pathDirs: path + extra, exists: { FileManager.default.fileExists(atPath: $0) })
    }

    func redetect() { if !demo { detection = Self.detectAgents() } }

    func refresh(_ model: AppModel) async {
        guard !demo else { return }
        if installWhenReady, model.daemon.status == .notInstalled, !model.daemon.busy {
            installWhenReady = false
            model.daemon.repair()
        }
        notifications = await Notifier.shared.access()
        inputMonitoringOK = CGPreflightListenEventAccess()
        await model.relay.refresh()
        if model.isConnected {
            do {
                if let s = try await client.hooksStatus() {
                    hooksNeedUpdate = false
                    if s != hooks { hooks = s }
                } else {
                    hooksNeedUpdate = true
                }
            } catch {
                // Daemon down or token trouble: keep what was last read.
            }
        }
        loaded = true
    }

    /// Poll while the checklist is open: every 3 s until the task is cancelled.
    func poll(_ model: AppModel) async {
        var tick = 0
        while !Task.isCancelled {
            await refresh(model)
            if tick % 3 == 0 { await model.channels.refresh() }
            tick += 1
            try? await Task.sleep(for: .seconds(3))
        }
    }

    func installHooks() async {
        guard !hooksBusy, !demo else { return }
        hooksBusy = true; hooksProblem = nil
        apply(await client.installHooks())
        hooksBusy = false
    }

    func uninstallHooks() async {
        guard !hooksBusy, !demo else { return }
        hooksBusy = true; hooksProblem = nil
        apply(await client.uninstallHooks())
        hooksBusy = false
    }

    private func apply(_ r: HooksActionResult) {
        if let s = r.status { hooks = s }
        if r.reason == RelayStatus.updateServiceSentence { hooksNeedUpdate = true }
        else if !r.ok { hooksProblem = r.reason }
    }
}

extension AppModel {
    var setupFacts: SetupFacts {
        let conductorHere = relay.status?.conductorInstalled
            ?? FileManager.default.fileExists(atPath: "/Applications/Conductor.app")
        let c = channels.channels
        let configured = (c?.telegram.configured ?? false) || (c?.cliq.oneWay ?? false) || (c?.cliq.twoWay ?? false)
            || (c?.phone.enabled ?? false) || !(channels.remote?.activeDevices.isEmpty ?? true)
        return SetupFacts(
            service: .from(daemon.status, connected: isConnected, busy: daemon.busy),
            hooks: setup.hooks, hooksNeedUpdate: setup.hooksNeedUpdate, hooksProblem: setup.hooksProblem,
            relay: relay.status, relayNeedUpdate: relay.needsServiceUpdate, conductorInstalled: conductorHere,
            conductorSkipped: setup.conductorSkipped, notifications: setup.notifications,
            inputMonitoringOK: setup.inputMonitoringOK, channelsConfigured: configured)
    }

    var setupChecklist: SetupChecklist { SetupChecklist(setupFacts) }

    var setupFlowFacts: SetupFlowFacts {
        SetupFlowFacts(
            setup: setupFacts, detection: setup.detection,
            hasActiveSession: sessions.contains { $0.state == .working || $0.state == .blocked || $0.state == .finished || $0.alive == true },
            awayConfigured: awayConfigured,
            connectBusy: daemon.busy || setup.hooksBusy || relay.busy)
    }

    /// A phone, the web app, Telegram, Cliq or phone calls is already set up.
    var awayConfigured: Bool {
        let c = channels.channels
        return (c?.phone.enabled ?? false) || !(channels.remote?.activeDevices.isEmpty ?? true)
            || (c?.telegram.configured ?? false) || (c?.cliq.oneWay ?? false) || (c?.cliq.twoWay ?? false)
            || (channels.voice.map { $0.isOn && $0.callee != nil } ?? false)
    }

    var setupFlow: SetupFlow { SetupFlow(setupFlowFacts, progress: setup.progress) }

    /// Remember what the facts show finished, so it stays finished.
    func recordSetupProgress() {
        guard !demoMode else { return }
        let done = setupFlow.newlyCompleted
        if !done.isEmpty { setup.progress.completed.formUnion(done) }
    }

    func skipSetupStage(_ s: SetupStage) { setup.progress.skipped = SetupFlow.skipping(s, in: setup.progress.skipped) }
    func unskipSetupStage(_ s: SetupStage) { setup.progress.skipped = SetupFlow.unskipping(s, in: setup.progress.skipped) }
    func startSetup() { setup.progress.started = true; setup.confirmInstallService() }
    func finishSetup() { setup.progress.finished = true; onboardingDone = true }

    /// Connect's button: run the steps in turn with the app's own actions.
    func startConnect() {
        setup.connectAttempted = []
        setup.connectRunning = true
        setup.redetect()
        stepConnect()
    }

    /// One move of the Connect run; the screen calls it on every poll. A failure leaves the run stopped.
    func stepConnect() {
        guard setup.connectRunning, !demoMode else { return }
        let flow = setupFlow
        if flow.connectReady { setup.connectRunning = false; return }
        guard let action = flow.nextConnectAction(attempted: setup.connectAttempted) else { return }
        setup.connectAttempted.insert(action)
        switch action {
        case .service: daemon.repair()
        case .hooks: Task { await setup.installHooks() }
        case .conductor: setup.conductorSkipped = false; Task { await relay.setUp() }
        }
    }

    /// Conductor's link would not come up: carry on without it (Settings › Conductor has it later).
    func continueWithoutConductor() { setup.conductorSkipped = true }

    /// What a checklist button does; shared by every walk-through screen.
    func perform(_ action: SetupAction) {
        func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }
        switch action {
        case .installService, .repairService:
            daemon.repair()
        case .installHooks:
            Task { await setup.installHooks() }
        case .setUpConductor:
            setup.conductorSkipped = false
            Task { await relay.setUp() }
        case .skipConductor:
            setup.conductorSkipped = true
        case .requestNotifications:
            Notifier.shared.requestAuthorization()
            Task { await setup.refresh(self) }
        case .openNotificationSettings:
            open("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        case .grantInputMonitoring:
            HotKeyCenter.shared.requestInputMonitoring()
        case .openAccessibility:
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        case .openChannels:
            openSettings(.connections)
        }
    }

    /// The menu's "Finish setting up" row: only after a first reading, and only while a required step remains.
    var setupNeedsAttention: Bool { setup.loaded && !setupChecklist.isComplete }
}
