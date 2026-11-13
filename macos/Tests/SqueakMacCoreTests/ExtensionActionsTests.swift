import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ExtensionActionsTests {
    @Test func pendingIsPerCard() {
        var s = ExtensionActionState()
        let first = s.begin("cliq")
        #expect(first)
        #expect(s.isPending("cliq"))
        #expect(!s.isPending("telegram") && !s.isPending("conductor"))
        let second = s.begin("cliq")
        #expect(!second)
        s.finish("cliq")
        #expect(s.pending.isEmpty)
    }

    @Test func errorStaysOnItsCardAndClearsOnRetry() {
        var s = ExtensionActionState()
        _ = s.begin("cliq")
        s.finish("cliq", error: ExtensionActionState.timedOutMessage("Zoho Cliq"))
        #expect(s.error("cliq") == "Zoho Cliq didn't answer in time. Try again.")
        #expect(s.error("telegram") == nil)
        let again = s.begin("cliq")
        #expect(again)
        #expect(s.error("cliq") == nil)
    }

    @Test func aSlowActionTimesOut() async {
        let slow = await ExtensionActionState.finishes(within: 0.1) { try? await Task.sleep(for: .seconds(5)) }
        #expect(slow == false)
        let fast = await ExtensionActionState.finishes(within: 5) {}
        #expect(fast)
    }

    @Test func notInThisBuildOffersNoAdd() {
        let addons = [
            AddonInfo(id: "conductor", name: "Conductor", blurb: "", available: true, enabled: false),
            AddonInfo(id: "rasanai", name: "RasanAI", blurb: "", available: true, enabled: false),
        ]
        let items = ExtensionList.items(addons: addons, telegram: nil, cliq: nil, voice: nil, builtInAddons: ["conductor"])
        #expect(items[0].offersAdd && !items[0].notInThisBuild)
        #expect(items[1].notInThisBuild && !items[1].offersAdd && !items[1].canAdd)
        #expect(items[2].offersAdd)
    }
}
