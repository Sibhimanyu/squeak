#if !SQUEAK_CONDUCTOR_RELAY
import Foundation
import Testing
@testable import SqueakMacCore

/// The release configuration: nothing of Conductor's relay is offered.
@Suite("Release build without the Conductor relay")
struct ConductorLinkReleaseTests {
    @Test func noConductorSetupStepOrRow() {
        let facts = SetupFacts(service: .running, hooks: HooksStatus(state: .installed), relay: nil, conductorInstalled: true)
        let ids = SetupChecklist(facts).steps.map(\.id)
        #expect(ids == [.service, .hooks, .notifications, .hotkey, .hands, .channels])
        let flow = SetupFlow(SetupFlowFacts(setup: facts, detection: AgentDetection(claudeCode: true, conductor: true), hasActiveSession: false, awayConfigured: false, connectBusy: false))
        #expect(flow.connectRows.map(\.id) == ["service", "hooks"])
        #expect(flow.nextConnectAction(attempted: []) == nil)
    }

    @Test func conductorIsNotASettingsPage() {
        #expect(!SettingsSection.groups.flatMap { $0 }.contains(.conductor))
        #expect(SettingsSection(link: "conductor") == nil)
    }

    @Test func handsStepDoesNotMentionALink() {
        let step = SetupChecklist(SetupFacts(service: .running)).step(.hands)
        #expect(!step.why.lowercased().contains("link"))
    }
}
#endif
