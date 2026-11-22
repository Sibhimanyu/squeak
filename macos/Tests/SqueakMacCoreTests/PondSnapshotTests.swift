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

@Suite("Pond live scrim")
struct PondLiveScrimTests {
    @Test func nothingOverAPageAtRestOrWhileTheStripCarriesTheGesture() {
        #expect(PondSnapshotPlan.liveScrim(x: 0, width: 900, snapshotActive: false, moving: false) == 0)
        #expect(PondSnapshotPlan.liveScrim(x: -900, width: 900, snapshotActive: false, moving: false) == 0)
        #expect(PondSnapshotPlan.liveScrim(x: 450, width: 900, snapshotActive: true, moving: true) == 0)
        #expect(PondSnapshotPlan.liveScrim(x: 0.4, width: 900, snapshotActive: false, moving: true) == 0)
    }
    @Test func liveSlideStillDims() {
        #expect(abs(PondSnapshotPlan.liveScrim(x: 900, width: 900, snapshotActive: false, moving: true) - 0.28) < 1e-9)
    }
}

@Suite("Pond layout position")
struct PondLayoutPositionTests {
    /// Live bug (greenroom, 2026-11-22): the pond page unmounted mid-snapshot-glide; its shared state kept
    /// snapshotActive with restPage dashboard, so the remounted Room sat a full width off screen, blank.
    @Test func staleSnapshotStateLeavesRoomOffScreen() {
        let stale = PondDrag.layoutPosition(staging: nil, snapshotActive: true, restPage: .dashboard, drawn: 1)
        #expect(PondDrag.x(of: .room, position: stale, width: 800) == 800)
    }

    /// After `unmount(page:)` the state is at rest on the page: the Room sits at 0.
    @Test func restedStateShowsRoom() {
        let rest = PondDrag.layoutPosition(staging: nil, snapshotActive: false, restPage: .room, drawn: PondDrag.home(.room))
        #expect(PondDrag.x(of: .room, position: rest, width: 800) == 0)
    }
}
