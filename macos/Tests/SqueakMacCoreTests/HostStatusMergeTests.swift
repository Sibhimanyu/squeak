import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct HostStatusMergeTests {
    /// Coming back from another Space reopens the chat stream, whose first status is "idle": a finished chat stays finished.
    @Test func reactivationNeverShowsIdleForAFinishedChat() {
        var shown = NativeAdapter.state(for: "idle", lastTurnEndedAt: Date())
        #expect(shown == .finished)
        for _ in 0..<3 {
            shown = HostStatusMerge.next(current: shown, fromStream: .idle)
            #expect(shown == .finished)
        }
    }

    @Test func realTransitionsStillLand() {
        #expect(HostStatusMerge.next(current: .finished, fromStream: .working) == .working)
        #expect(HostStatusMerge.next(current: .working, fromStream: .idle) == .idle)
        #expect(HostStatusMerge.next(current: .finished, fromStream: .error) == .error)
        #expect(HostStatusMerge.next(current: .idle, fromStream: .idle) == .idle)
        #expect(HostStatusMerge.next(current: .finished, fromStream: .blocked) == .blocked)
    }
}
