import Testing
@testable import SqueakMacCore

@Suite struct UpdateFooterRowTests {
    private func labels(_ items: [UpdateFooterRow.Item]) -> [String] { items.map(\.label) }

    @Test func eachStateStatusAndActions() {
        typealias R = UpdateFooterRow
        #expect(R.items(.checking).isEmpty && UpdateFlowCopy.footerStatus(.checking) == "Checking…")
        #expect(R.items(.upToDate).isEmpty && UpdateFlowCopy.footerStatus(.upToDate) == "Up to date")
        #expect(labels(R.items(.available(version: "2.0"))) == ["Install", "Later"])
        #expect(labels(R.items(.available(version: "2.0"), inPlaceDenied: true)) == ["Install", "Download and install by hand"])
        #expect(labels(R.items(.downloading(version: "2.0", progress: 0.4))) == ["Cancel"])
        #expect(labels(R.items(.extracting(version: "2.0", progress: nil))) == ["Cancel"])
        #expect(labels(R.items(.readyToInstall(version: "2.0"))) == ["Restart to update"])
        #expect(UpdateFlowCopy.footerStatus(.readyToInstall(version: "2.0")) == "Version 2.0 is ready")
        #expect(labels(R.items(.readyToInstall(version: "2.0"), inPlaceDenied: true)) == ["Try again", "Download and install by hand"])
        #expect(R.items(.installing(version: "2.0")).isEmpty && R.items(.relaunching(version: nil)).isEmpty)
        #expect(labels(R.items(.installing(version: "2.0"), canRetryTermination: true)) == ["Try again"])
        #expect(labels(R.waitingItems()) == ["Cancel"])
        #expect(labels(R.engineItems()) == ["Restart now"])
        #expect(EngineCatchUp.line(chats: 2) == "Engine update waits for 2 chats")
    }

    @Test func failureOffersRecoveries() {
        let f = UpdateFlow.Failure(stage: .download, reason: "x", version: nil, recoveries: [.tryAgain, .downloadManually])
        let items = UpdateFooterRow.items(.failed(f))
        #expect(items.first?.label == "Try again")
        #expect(items.contains { $0.label == "Download installer" })
    }

    @Test func onlyTheFirstActionIsPrimary() {
        for phase in [UpdateFlow.Phase.available(version: "2.0"), .readyToInstall(version: "2.0"), .downloading(version: "2.0", progress: nil)] {
            let items = UpdateFooterRow.items(phase)
            #expect(items.first?.primary == true)
            #expect(items.dropFirst().allSatisfy { !$0.primary })
        }
        #expect(UpdateFooterRow.waitingItems().allSatisfy { !$0.primary })
    }
}
