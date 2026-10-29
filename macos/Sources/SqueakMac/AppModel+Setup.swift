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
    /// Walk-through step ids the person passed on, kept across launches.
    var walkSkipped: Set<String> { didSet { defaults.set(Array(walkSkipped).sorted(), forKey: "setupWalkSkipped") } }
    /// The person pressed the one Welcome button: install the background service as soon as it is known to be missing.
    @ObservationIgnored private var installWhenReady = false

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private let defaults = UserDefaults.standard

    init(client: DaemonClient, demo: Bool) {
        self.client = client
        self.demo = demo
        conductorSkipped = demo ? false : UserDefaults.standard.bool(forKey: "setupConductorSkipped")
        walkSkipped = demo ? [] : Set(UserDefaults.standard.stringArray(forKey: "setupWalkSkipped") ?? [])
        if demo {
            hooks = DemoData.setupHooks
            notifications = .notDetermined
            inputMonitoringOK = false
            loaded = true
        }
    }

    /// The Welcome button: the person has said yes, so the service is installed by Squeak itself.
    func confirmInstallService() { installWhenReady = true }

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

    var walkFacts: WalkFacts {
        let c = channels.channels
        return WalkFacts(
            setup: setupFacts,
            iphone: (c?.phone.enabled ?? false) || !(channels.remote?.activeDevices.isEmpty ?? true),
            telegram: c?.telegram.configured ?? false,
            cliq: (c?.cliq.oneWay ?? false) || (c?.cliq.twoWay ?? false),
            voice: channels.voice.map { $0.isOn && $0.callee != nil } ?? false,
            awake: awakeLidReady)
    }

    var walkthrough: SetupWalkthrough { SetupWalkthrough(walkFacts, skipped: setup.walkSkipped) }

    func skipWalkStep(_ s: WalkStep) {
        setup.walkSkipped = SetupWalkthrough.skipping(s, in: setup.walkSkipped)
        if s == .conductor { setup.conductorSkipped = true }
    }

    func unskipWalkStep(_ s: WalkStep) {
        setup.walkSkipped = SetupWalkthrough.unskipping(s, in: setup.walkSkipped)
        if s == .conductor { setup.conductorSkipped = false }
    }

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
            skipWalkStep(.conductor)
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
