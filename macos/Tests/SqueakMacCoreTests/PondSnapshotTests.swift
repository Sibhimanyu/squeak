import Testing

@testable import SqueakMacCore

@Suite("Pond snapshot glide")
struct PondSnapshotTests {
    @Test func destinationIsTheOtherPage() {
        #expect(PondSnapshotPlan.destination(of: .dashboard) == .room)
        #expect(PondSnapshotPlan.destination(of: .room) == .dashboard)
    }

    /// Dashboard -> Room at progress p and Room -> Dashboard at the same progress are exact mirrors of each other.
    @Test func bothDirectionsAreMirrors() {
        let w = 900.0
        for p in stride(from: 0.0, through: 1.0, by: 0.125) {
            let fwd = (src: PondSnapshotPlan.x(of: .dashboard, position: p, width: w), dst: PondSnapshotPlan.x(of: .room, position: p, width: w))
            let back = (src: PondSnapshotPlan.x(of: .room, position: 1 - p, width: w), dst: PondSnapshotPlan.x(of: .dashboard, position: 1 - p, width: w))
            #expect(fwd.src == -back.src)
            #expect(fwd.dst == -back.dst)
            #expect(PondSnapshotPlan.scrim(x: fwd.src, width: w) == PondSnapshotPlan.scrim(x: back.src, width: w))
            #expect(PondSnapshotPlan.scrim(x: fwd.dst, width: w) == PondSnapshotPlan.scrim(x: back.dst, width: w))
        }
        // Start and end: the leaving page at 0, the arriving one a width away on the side it comes from.
        #expect(PondSnapshotPlan.x(of: .room, position: 0, width: w) == w)
        #expect(PondSnapshotPlan.x(of: .dashboard, position: 1, width: w) == -w)
    }

    @Test func theArrivingPageIsAlwaysOnTop() {
        for rest in PondPage.allCases {
            let dst = PondSnapshotPlan.destination(of: rest)
            #expect(PondSnapshotPlan.zPosition(of: dst, rest: rest) > PondSnapshotPlan.zPosition(of: rest, rest: rest))
        }
    }

    @Test func scrimGrowsWithDistance() {
        #expect(PondSnapshotPlan.scrim(x: 0, width: 800) == 0)
        #expect(PondSnapshotPlan.scrim(x: 800, width: 800) == 0.28)
        #expect(PondSnapshotPlan.scrim(x: -400, width: 800) == 0.14)
    }

    @Test func fallbackDecision() {
        #expect(PondSnapshotPlan.usable(width: 800, height: 600, capturedBoth: true, identical: false))
        #expect(!PondSnapshotPlan.usable(width: 800, height: 600, capturedBoth: false, identical: false))
        #expect(!PondSnapshotPlan.usable(width: 800, height: 600, capturedBoth: true, identical: true))
        #expect(!PondSnapshotPlan.usable(width: 0, height: 600, capturedBoth: true, identical: false))
    }
}
