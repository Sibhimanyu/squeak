import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Cliq in-app setup")
struct CliqSetupTests {
    private let json = Data("""
    {"blocks":[
      {"id":"squeakreply","title":"Reply form function","where":"c","code":"cc"},
      {"id":"message","title":"Message handler","where":"a","code":"aa"},
      {"id":"squeakbutton","title":"Button function","where":"b","code":"bb"}],
     "relayReady":true,"lastTapAt":"2026-11-12T10:00:00.000Z","inbox":"both"}
    """.utf8)

    @Test func stepsAreNumberedInPasteOrder() throws {
        let view = try JSONDecoder().decode(CliqHandlersView.self, from: json)
        let steps = CliqSetupModel.steps(view)
        #expect(steps.map(\.id) == ["message", "squeakbutton", "squeakreply"])
        #expect(steps.map(\.number) == [1, 2, 3])
        #expect(steps[1].place == "b" && steps[1].code == "bb")
        #expect(view.inbox == "both")
    }

    @Test func notReadyDecodesWithNoBlocks() throws {
        let view = try JSONDecoder().decode(CliqHandlersView.self, from: Data(#"{"blocks":[],"relayReady":false,"inbox":"catalyst"}"#.utf8))
        #expect(!view.relayReady && view.lastTapAt == nil && CliqSetupModel.steps(view).isEmpty)
    }

    @Test func tapTicksOnlyWhenLastTapAtChanges() {
        #expect(CliqSetupModel.tapStatus(baseline: nil, current: nil) == .waiting)
        #expect(CliqSetupModel.tapStatus(baseline: nil, current: "t1") == .received("t1"))
        #expect(CliqSetupModel.tapStatus(baseline: "t1", current: "t1") == .alreadyWorking("t1"))
        #expect(CliqSetupModel.tapStatus(baseline: "t1", current: "t2") == .received("t2"))
    }

    @Test func copyShowsCopiedForOneAndAHalfSeconds() {
        var feedback = CopyButtons()
        let t0 = Date(timeIntervalSince1970: 1000)
        #expect(feedback.label("message", at: t0) == "Copy")
        feedback.press("message", at: t0)
        #expect(feedback.label("message", at: t0.addingTimeInterval(1.4)) == "Copied ✓")
        #expect(feedback.label("message", at: t0.addingTimeInterval(1.5)) == "Copy")
        #expect(feedback.label("squeakbutton", at: t0.addingTimeInterval(0.1)) == "Copy")
    }

    @Test func regenerateResultToleratesAFailureBody() throws {
        let r = try JSONDecoder().decode(CliqRegenerateResult.self, from: Data(#"{"ok":false,"reason":"No relay"}"#.utf8))
        #expect(!r.ok && !r.needsRelayDeploy && r.reason == "No relay")
    }

    private func view(_ json: String) throws -> CliqHandlersView {
        try JSONDecoder().decode(CliqHandlersView.self, from: Data(json.utf8))
    }

    @Test func pageStates() throws {
        #expect(CliqSetupModel.page(nil, outdated: true) == .outdated)
        #expect(CliqSetupModel.page(nil, outdated: false) == .loading)
        #expect(CliqSetupModel.page(try view(#"{"blocks":[],"relayReady":true}"#), outdated: false) == .ready)
        // A hosted Mac's key is registered by the daemon: ready is ready, with no key step to show.
        #expect(CliqSetupModel.page(try view(#"{"blocks":[],"relayReady":true,"automatic":true}"#), outdated: false) == .ready)
        #expect(CliqSetupModel.page(try view(#"{"blocks":[],"relayReady":false,"automatic":true}"#), outdated: false) == .gettingKey)
        #expect(CliqSetupModel.page(try view(#"{"blocks":[],"relayReady":false}"#), outdated: false) == .needsHandlers)
        let failed = try view(#"{"blocks":[],"relayReady":false,"automatic":true,"registerError":"Squeak's cloud could not set up Cliq."}"#)
        #expect(CliqSetupModel.page(failed, outdated: false) == .failed("Squeak's cloud could not set up Cliq."))
    }
}
