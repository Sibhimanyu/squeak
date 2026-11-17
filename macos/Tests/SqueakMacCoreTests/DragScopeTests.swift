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
            // Every tab kind, ducklings included, lands on any of the three strips.
            for t in Self.strips { #expect(DragScope.allows(k, on: t) == true, "\(k) on \(t)") }
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

@Suite struct DragPayloadFallbackTests {
    static let items: [DockItem] = [.thread("claude:abc"), .panel(.pond), .terminal(UUID()), .file("/tmp/a.txt")]

    @Test func everyTabKindRoundTripsAndIsSniffedFromPlainText() {
        for item in Self.items {
            let text = DockItemPayload.encode(item)
            #expect(DockItemPayload.decode(text) == item)
            // The plain-text half alone (custom type missing) still names the kind and lands on every strip.
            #expect(DragKind.sniff(text) == DragKind.of(item))
            for t in [DragTarget.centreStrip, .rightStrip, .bottomStrip] {
                #expect(DragKind.accepted(text, on: t) == DragKind.of(item))
            }
            #expect(DragKind.accepted(text, on: .pondList) == nil)
        }
    }

    @Test func pondAndFileTokenFallBackToPlainText() {
        let pond = PondDragPayload.encode("dir-1")
        #expect(PondDragPayload.decode(pond) == "dir-1")
        #expect(DragKind.accepted(pond, on: .pondList) == .pond)
        #expect(DragKind.accepted(pond, on: .centreStrip) == nil)
        #expect(DragKind.accepted("squeak-file:/r\n/r/a", on: .fileTree) == .fileToken)
    }

    @Test func ordinaryTextIsNeverAccepted() {
        #expect(DragKind.sniff("hello") == nil)
        for t in [DragTarget.centreStrip, .pondList, .fileTree] { #expect(DragKind.accepted("hello", on: t) == nil) }
    }

    @Test func everyKindHasADistinctIdentifier() {
        #expect(Set(DragKind.allCases.map(\.identifier)).count == DragKind.allCases.count)
    }
}
