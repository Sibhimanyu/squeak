import Foundation
import SqueakMacCore
import Testing

@testable import ConductorRelay

@MainActor
@Suite struct RelayModelTests {
    private func model() -> RelayModel {
        RelayModel(client: DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, tokenProvider: { nil }), demo: true)
    }

    @Test func registersAsTheConductorLink() {
        let registry = AddonRegistry.shared
        registry.removeAll()
        #expect(!AddonRegistry.hasConductorLink)
        registry.register(conductorLink: model())
        #expect(AddonRegistry.hasConductorLink)
        registry.removeAll()
        #expect(registry.conductorLink == nil)
    }

    @Test func demoIsConnectedAndOffersOnlyAConfirmedReset() {
        let m = model()
        #expect(m.reading == ConductorLinkReading(state: .connected, message: m.status!.message, conductorInstalled: true))
        let page = m.page
        #expect(page.headline?.tone == .good)
        #expect(page.actions.map(\.id) == ["reset"])
        #expect(page.actions[0].confirmation?.destructive == true)
    }

    @Test func relayProblemsAreRecognisedByTheirWords() {
        let m = model()
        #expect(m.isLinkProblem("Conductor's relay isn't connected"))
        #expect(!m.isLinkProblem("Something else broke"))
        #expect(!m.isLinkProblem(nil))
    }
}
