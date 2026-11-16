import Testing
import Foundation
@testable import SqueakMacCore

@Suite struct DragScopeTests {
    static let strips: [DragTarget] = [.centreStrip, .rightStrip, .bottomStrip, .edgeStrip(.right), .edgeStrip(.bottom)]

    @Test func pondOnlyReordersInThePondList() {
        for t in Self.strips + [.fileTree] { #expect(!DragScope.allows(.pond, on: t)) }
        #expect(DragScope.allows(.pond, on: .pondList))
    }

    @Test func everyTabKindIsAcceptedByEveryStripAndOnlyThere() {
        for k in DragScope.tabKinds {
            for t in Self.strips { #expect(DragScope.allows(k, on: t), "\(k) on \(t)") }
            #expect(!DragScope.allows(k, on: .pondList))
            #expect(!DragScope.allows(k, on: .fileTree))
        }
    }

    @Test func fileTokenOnlyGoesToTheFileTree() {
        for t in Self.strips + [.pondList] { #expect(!DragScope.allows(.fileToken, on: t)) }
        #expect(DragScope.allows(.fileToken, on: .fileTree))
    }

    @Test func acceptedListMatchesAllows() {
        for t in Self.strips + [.pondList, .fileTree] {
            for k in DragKind.allCases { #expect(DragScope.accepted(by: t).contains(k) == DragScope.allows(k, on: t)) }
        }
        #expect(DragScope.accepted(by: .pondList) == [.pond])
    }

    @Test func stripForZone() {
        #expect(DragTarget.strip(.centre) == .centreStrip)
        #expect(DragTarget.strip(.right) == .rightStrip)
        #expect(DragTarget.strip(.bottom) == .bottomStrip)
    }

    @Test func itemsMapToTheirKind() {
        #expect(DragKind.of(.thread("k")) == .thread)
        #expect(DragKind.of(.panel(.code)) == .panel)
        #expect(DragKind.of(.terminal(UUID())) == .terminal)
        #expect(DragKind.of(.file("/x")) == .file)
        #expect(Set(DragKind.allCases.map(\.identifier)).count == DragKind.allCases.count)
    }

    @Test func pondPanelNeverDocksInTheCentreButOpensTheDashboard() {
        #expect(!DragScope.allows(DockItem.panel(.pond), on: .centreStrip))
        #expect(DragScope.opensPondDashboard(.panel(.pond), on: .centreStrip))
        for t in [DragTarget.rightStrip, .bottomStrip, .edgeStrip(.right)] {
            #expect(DragScope.allows(DockItem.panel(.pond), on: t))
            #expect(!DragScope.opensPondDashboard(.panel(.pond), on: t))
        }
        #expect(DragScope.allows(DockItem.panel(.thread), on: .centreStrip))
        #expect(DragScope.allows(DockItem.panel(.code), on: .centreStrip))
        // The pasteboard type is the same for every panel, so the strip still validates it; the drop routes it.
        #expect(DragScope.allows(.panel, on: .centreStrip))
    }
}
