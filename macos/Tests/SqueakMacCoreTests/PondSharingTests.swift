import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Pond sharing") struct PondSharingTests {
    private func pond(role: PondRole = .member, owner: String? = "Aarav Patel", local: Bool = false, status: String = "active", members: Int = 2) -> PondSummary {
        let json = """
        {"id":"p1","name":"test","role":"\(role.rawValue)","memberCount":\(members),"threadCount":0,"needsYou":0,"local":\(local),"status":"\(status)"\(owner.map { ",\"ownerName\":\"\($0)\"" } ?? "")}
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
        #expect(PondSharing.badge(for: pond()) == .init(initials: "AP", label: "Aarav Patel\u{2019}s Pond \u{00B7} you\u{2019}re a Member"))
        #expect(PondSharing.badge(for: pond(owner: "sibhi")) == .init(initials: "S", label: "sibhi\u{2019}s Pond \u{00B7} you\u{2019}re a Member"))
        #expect(PondSharing.badge(for: pond(owner: nil)) == .init(initials: nil, label: "Shared with you \u{00B7} you\u{2019}re a Member"))
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
        let mine = PondFilter.apply(entries, label: nil, showHidden: true, scope: .notShared)
        #expect(mine.names == ["a", "d"] && mine.hiddenCount == 0)
    }

    @Test func funnelIsActiveForALabelOrANarrowScope() {
        #expect(!PondFilter.isActive(label: "", scope: .all))
        #expect(!PondFilter.isActive(label: nil, scope: .all))
        #expect(PondFilter.isActive(label: "work", scope: .all))
        #expect(PondFilter.isActive(label: "", scope: .shared))
        #expect(PondFilter.isActive(label: nil, scope: .notShared))
        #expect(PondSharing.Scope.all.menuTitle == "All ponds")
    }

    @Test func filterOutcomesForEveryKindOfPond() {
        let owned = pond(role: .owner, members: 1)
        let sharedOut = pond(role: .owner, members: 3)
        let sharedWithMe = pond(role: .member)
        let viewer = pond(role: .viewer)
        let local = pond(role: .owner, local: true, members: 1)
        let pending = pond(status: "pending")
        let shared: [PondSummary?] = [sharedOut, sharedWithMe, viewer]
        let notShared: [PondSummary?] = [owned, local, pending, nil]
        for p in shared {
            #expect(PondSharing.matches(.shared, shared: PondSharing.isShared(p)))
            #expect(!PondSharing.matches(.notShared, shared: PondSharing.isShared(p)))
        }
        for p in notShared {
            #expect(!PondSharing.matches(.shared, shared: PondSharing.isShared(p)))
            #expect(PondSharing.matches(.notShared, shared: PondSharing.isShared(p)))
        }
        for p in shared + notShared { #expect(PondSharing.matches(.all, shared: PondSharing.isShared(p))) }
        #expect(!PondSharing.isSharedOut(pond(role: .owner, status: "pending", members: 3)))
    }

    @Test func savedScopeRestores() {
        #expect(PondSharing.Scope.restore("mine") == .notShared)
        #expect(PondSharing.Scope.restore("shared") == .shared)
        #expect(PondSharing.Scope.restore("notShared") == .notShared)
        #expect(PondSharing.Scope.restore("junk") == .all && PondSharing.Scope.restore(nil) == .all)
        #expect(PondSharing.Scope.allCases.map(\.title) == ["All", "Shared", "Not shared"])
    }

    @Test func orderStaysAsGiven() {
        let entries = [PondFilter.Entry(name: "new", shared: true), PondFilter.Entry(name: "mid"), PondFilter.Entry(name: "old", shared: true)]
        #expect(PondFilter.apply(entries, label: nil, showHidden: false, scope: .shared).names == ["new", "old"])
    }

    @Test func leaveConfirmNamesTheOwner() {
        #expect(PondActionWords.leaveMessage("greenroom", owner: "Sibhi") == "Your messages stay in the Room under your name. To come back you need a new invite from Sibhi.")
        #expect(PondActionWords.leaveMessage("greenroom").hasSuffix("from the owner."))
    }
}
