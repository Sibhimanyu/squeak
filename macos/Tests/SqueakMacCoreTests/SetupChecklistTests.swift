import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Setup checklist")
struct SetupChecklistTests {
    private let installed = HooksStatus(state: .installed, message: "Hooks are installed.")
    private let connected = RelayStatus(state: .connected)

    private func ready(_ tweak: (inout SetupFacts) -> Void = { _ in }) -> SetupFacts {
        var f = SetupFacts(service: .running, hooks: installed, relay: connected, notifications: .authorized, inputMonitoringOK: true, channelsConfigured: true)
        tweak(&f)
        return f
    }

    @Test func orderIsFixed() {
        #expect(SetupChecklist(SetupFacts()).steps.map(\.id) == [.service, .hooks, .conductor, .notifications, .hotkey, .hands, .channels])
    }

    @Test func freshMacHasTheServiceFirstAndOthersBlocked() {
        let c = SetupChecklist(SetupFacts(service: .notInstalled, conductorInstalled: true))
        #expect(c.step(.service).state == .todo && c.step(.service).action == .installService)
        #expect(c.step(.hooks).state == .blocked && c.step(.conductor).state == .blocked)
        #expect(c.primary == .service && !c.isComplete)
    }

    @Test func serviceStates() {
        #expect(SetupChecklist(ready()).step(.service).state == .done)
        #expect(SetupChecklist(SetupFacts(service: .failed("port busy"))).step(.service).state == .error)
        #expect(SetupChecklist(SetupFacts(service: .failed("port busy"))).step(.service).why == "port busy")
        #expect(SetupChecklist(SetupFacts(service: .failed("x"))).step(.service).action == .repairService)
        #expect(SetupChecklist(SetupFacts(service: .installing)).step(.service).action == nil)
        #expect(SetupChecklist(SetupFacts(service: .unavailable)).step(.service).state == .error)
    }

    @Test func serviceFactFromDaemonStatus() {
        #expect(SetupServiceFact.from(.notInstalled, connected: false, busy: false) == .notInstalled)
        #expect(SetupServiceFact.from(.notInstalled, connected: false, busy: true) == .installing)
        #expect(SetupServiceFact.from(.devCheckout, connected: true, busy: false) == .running)
        #expect(SetupServiceFact.from(.failed(reason: "r", running: nil), connected: false, busy: false) == .failed("r"))
        #expect(SetupServiceFact.from(.unavailable, connected: false, busy: false) == .unavailable)
    }

    @Test func hooksTransitions() {
        func hooks(_ tweak: (inout SetupFacts) -> Void) -> SetupStep { SetupChecklist(ready(tweak)).step(.hooks) }
        #expect(hooks { $0.hooks = nil }.state == .todo)
        #expect(hooks { $0.hooks = nil }.action == .installHooks)
        #expect(hooks { $0.hooks = HooksStatus(state: .missing) }.state == .todo)
        #expect(hooks { $0.hooks = HooksStatus(state: .partial) }.actionTitle == "Finish installing")
        #expect(hooks { $0.hooks = HooksStatus(state: .error, message: "settings.json is unreadable") }.state == .error)
        #expect(hooks { $0.hooks = HooksStatus(state: .error, message: "settings.json is unreadable") }.why == "settings.json is unreadable")
        #expect(hooks { $0.hooks = HooksStatus(state: .unknown) }.state == .error)
        #expect(hooks { $0.hooks = nil; $0.hooksNeedUpdate = true }.why == "Update the background service")
        #expect(hooks { $0.hooks = nil; $0.hooksProblem = "Couldn't write" }.state == .error)
        #expect(hooks { _ in }.state == .done)
        #expect(hooks { $0.service = .installing }.state == .blocked)
    }

    @Test func conductorStates() {
        func c(_ tweak: (inout SetupFacts) -> Void) -> SetupStep { SetupChecklist(ready(tweak)).step(.conductor) }
        #expect(c { _ in }.state == .done)
        #expect(c { $0.relay = RelayStatus(state: .off, message: "Not set up") }.state == .todo)
        #expect(c { $0.relay = RelayStatus(state: .off, message: "Not set up") }.why == "Not set up")
        #expect(c { $0.relay = RelayStatus(state: .off) }.secondaryAction == .skipConductor)
        #expect(c { $0.relay = RelayStatus(state: .error) }.state == .error)
        #expect(c { $0.relay = nil; $0.service = .notInstalled }.state == .blocked)
        #expect(c { $0.relay = nil; $0.relayNeedUpdate = true }.state == .error)
        #expect(c { $0.conductorInstalled = false; $0.relay = nil }.state == .optional)
        #expect(c { $0.relay = RelayStatus(state: .notInstalled) }.required == false)
        #expect(c { $0.relay = RelayStatus(state: .off); $0.conductorSkipped = true }.state == .optional)
        #expect(c { $0.relay = RelayStatus(state: .off); $0.conductorSkipped = true }.required == false)
    }

    @Test func notificationAndHotkeyStates() {
        func n(_ a: NotificationAccess) -> SetupStep { SetupChecklist(ready { $0.notifications = a }).step(.notifications) }
        #expect(n(.authorized).state == .done)
        #expect(n(.notDetermined).action == .requestNotifications)
        #expect(n(.unknown).action == .requestNotifications)
        #expect(n(.denied).action == .openNotificationSettings)
        #expect(SetupChecklist(ready { $0.inputMonitoringOK = false }).step(.hotkey).action == .grantInputMonitoring)
        #expect(SetupChecklist(ready()).step(.hotkey).state == .done)
    }

    @Test func handsIsNeverClaimedGranted() {
        #expect(SetupChecklist(ready()).step(.hands).state == .optional)
        let down = SetupChecklist(ready { $0.relay = RelayStatus(state: .waiting) }).step(.hands)
        #expect(down.state == .optional && down.action == .openAccessibility)
        for f in [SetupFacts(), ready(), ready { $0.relay = nil }] { #expect(SetupChecklist(f).step(.hands).state != .done) }
    }

    @Test func channelsAreOptional() {
        #expect(SetupChecklist(ready { $0.channelsConfigured = false }).step(.channels).state == .optional)
        #expect(SetupChecklist(ready()).step(.channels).state == .done)
    }

    @Test func primaryIsTheFirstUnfinishedRequiredStep() {
        #expect(SetupChecklist(ready { $0.hooks = nil }).primary == .hooks)
        #expect(SetupChecklist(ready { $0.hooks = nil; $0.relay = RelayStatus(state: .off) }).primary == .hooks)
        #expect(SetupChecklist(ready { $0.relay = RelayStatus(state: .off) }).primary == .conductor)
        #expect(SetupChecklist(ready { $0.service = .failed("x") }).primary == .service)
    }

    @Test func optionalStepsNeverBlockComplete() {
        let c = SetupChecklist(ready { $0.notifications = .denied; $0.inputMonitoringOK = false; $0.channelsConfigured = false })
        #expect(c.isComplete && c.primary == nil && c.requiredRemaining == 0)
        #expect(SetupChecklist(ready { $0.relay = RelayStatus(state: .off); $0.conductorSkipped = true }).isComplete)
        #expect(SetupChecklist(ready { $0.conductorInstalled = false; $0.relay = nil }).isComplete)
        #expect(!SetupChecklist(ready { $0.hooks = nil }).isComplete)
    }

    @Test func progressCountsDoneSteps() {
        #expect(SetupChecklist(ready()).progressLabel == "6 of 7 done")
        #expect(SetupChecklist(SetupFacts(service: .notInstalled)).progressLabel == "0 of 7 done")
    }
}
