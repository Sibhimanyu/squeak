import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Squeak Hands grants")
struct HandsGrantsTests {
    func decode(_ json: String) throws -> HandsGrants { try JSONDecoder().decode(HandsGrants.self, from: Data(json.utf8)) }

    @Test func readsTheDaemonsAnswer() throws {
        let g = try decode(#"{"outdated":false,"accessibility":true,"location":"denied","automationTerminal":"granted"}"#)
        #expect(g.grant(for: .accessibility) == .granted)
        #expect(g.grant(for: .location) == .denied)
        #expect(g.grant(for: .automation) == .granted)
        #expect(g.grant(for: .notifications) == nil)
    }

    @Test func anOutdatedHandsReadsNothing() throws {
        let g = try decode(#"{"outdated":true}"#)
        #expect(g.outdated)
        #expect(g.grant(for: .accessibility) == nil)
    }

    @Test func aGrantedReadingTicksTheFlowWithoutAPress() throws {
        let flow = PermissionFlow(kind: .accessibility, grant: .unreadable)
        let on = flow.readingHands(try decode(#"{"outdated":false,"accessibility":true,"location":"notDetermined","automationTerminal":"notRunning"}"#))
        #expect(on.isGranted)
        #expect(!on.offersConfirm)
    }

    @Test func anOutdatedHandsKeepsTheManualButtonAndSaysUpdate() {
        var flow = PermissionFlow(kind: .automation, grant: .unreadable).readingHands(.outdatedBuild).pressed()
        #expect(flow.offersConfirm)
        #expect(flow.outdatedLine?.contains("Update Squeak Hands") == true)
        flow = flow.confirmedByPerson()
        #expect(flow.isGranted)
        #expect(flow.outdatedLine == nil)
    }

    @Test func aReadingHandsNeverOffersTheManualButton() throws {
        let off = PermissionFlow(kind: .location, grant: .unreadable)
            .readingHands(try decode(#"{"outdated":false,"accessibility":false,"location":"notDetermined","automationTerminal":"notRunning"}"#))
            .pressed()
        #expect(!off.isGranted)
        #expect(!off.offersConfirm)
        #expect(off.outdatedLine == nil)
    }

    @Test func noAnswerFromTheDaemonLeavesItUnreadable() {
        let flow = PermissionFlow(kind: .accessibility).readingHands(nil)
        #expect(flow.grant == .unreadable)
    }

    @Test func installerCopiesOnlyANewerBundledHands() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("hands-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        func app(_ name: String, version: String) throws -> URL {
            let url = root.appendingPathComponent(name)
            try fm.createDirectory(at: url.appendingPathComponent("Contents"), withIntermediateDirectories: true)
            let plist = ["CFBundleVersion": version] as [String: Any]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
                .write(to: url.appendingPathComponent("Contents/Info.plist"))
            return url
        }
        let bundled = try app("bundled/Squeak Hands.app", version: "2")
        let installed = root.appendingPathComponent("support/Squeak Hands.app")
        #expect(HandsInstaller.reconcile(bundled: root.appendingPathComponent("none.app"), installed: installed) == .noBundledCopy)
        #expect(HandsInstaller.reconcile(bundled: bundled, installed: installed) == .installed(version: 2))
        #expect(HandsInstaller.version(of: installed) == 2)
        #expect(HandsInstaller.reconcile(bundled: bundled, installed: installed) == .upToDate)
        // An owner's newer build is never replaced by an older bundled one.
        try fm.removeItem(at: installed)
        _ = try app("support/Squeak Hands.app", version: "9")
        #expect(HandsInstaller.reconcile(bundled: bundled, installed: installed) == .upToDate)
        #expect(HandsInstaller.version(of: installed) == 9)
    }

    @Test func notifySettingsCountsCardsPushedToday() throws {
        let json = #"{"telegram":{"muted":false},"cliq":{"muted":false},"channels":{"telegram":true,"cliq":true},"pushedToday":{"telegram":3,"cliq":31}}"#
        let n = try JSONDecoder().decode(NotifySettings.self, from: Data(json.utf8))
        #expect(n.mostPushedToday == 31)
        let old = try JSONDecoder().decode(NotifySettings.self, from: Data(#"{"telegram":{"muted":false},"channels":{"telegram":true}}"#.utf8))
        #expect(old.mostPushedToday == 0)
    }
}
