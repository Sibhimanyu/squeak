import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Pond sharing") struct PondSharingTests {
    private func pond(role: PondRole = .member, owner: String? = "Aarav Patel", local: Bool = false, status: String = "active") -> PondSummary {
        let json = """
        {"id":"p1","name":"test","role":"\(role.rawValue)","memberCount":2,"threadCount":0,"needsYou":0,"local":\(local),"status":"\(status)"\(owner.map { ",\"ownerName\":\"\($0)\"" } ?? "")}
        """
        return try! JSONDecoder().decode(PondSummary.self, from: Data(json.utf8))
    }

    @Test func sharedMeansActiveAndNotOwner() {
        #expect(PondSharing.isSharedWithMe(pond()))
        #expect(PondSharing.isSharedWithMe(pond(role: .viewer)))
        #expect(!PondSharing.isSharedWithMe(pond(role: .owner)))
        #expect(!PondSharing.isSharedWithMe(pond(local: true)))
        #expect(!PondSharing.isSharedWithMe(pond(status: "pending")))
        #expect(!PondSharing.isSharedWithMe(nil))
    }

    @Test func badgeNamesTheSharer() {
        #expect(PondSharing.badge(for: pond()) == .init(initials: "AP", label: "Shared with you by Aarav Patel"))
        #expect(PondSharing.badge(for: pond(owner: "sibhi")) == .init(initials: "S", label: "Shared with you by sibhi"))
        #expect(PondSharing.badge(for: pond(owner: nil)) == .init(initials: nil, label: "Shared with you"))
        #expect(PondSharing.badge(for: pond(role: .owner)) == nil)
    }

    @Test func initials() {
        #expect(PondSharing.initials("ada king lovelace") == "AL")
        #expect(PondSharing.initials("  ") == nil)
    }

    @Test func scopeFiltersAndKeepsHiddenCount() {
        let entries = [
            PondFilter.Entry(name: "a"), PondFilter.Entry(name: "b", shared: true),
            PondFilter.Entry(name: "c", hidden: true, shared: true), PondFilter.Entry(name: "d", hidden: true),
        ]
        #expect(PondFilter.apply(entries, label: nil, showHidden: false).names == ["a", "b"])
        let shared = PondFilter.apply(entries, label: nil, showHidden: false, scope: .shared)
        #expect(shared.names == ["b"] && shared.hiddenCount == 1)
        let mine = PondFilter.apply(entries, label: nil, showHidden: true, scope: .mine)
        #expect(mine.names == ["a", "d"] && mine.hiddenCount == 0)
    }
}
