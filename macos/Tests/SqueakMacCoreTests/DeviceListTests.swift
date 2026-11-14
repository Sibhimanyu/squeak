import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct DeviceListTests {
    private var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    private func day(_ d: Int) -> Date { DateComponents(calendar: utc, timeZone: utc.timeZone, year: 2026, month: 11, day: d, hour: 12).date! }
    private func device(_ id: String, _ name: String, at: Date? = nil, account: Bool = false, revoked: Bool = false) -> RemoteStatus.Device {
        .init(id: id, name: name, pairedAt: at, revokedAt: revoked ? Date() : nil, via: account ? "account" : nil, addedAutomatically: account ? true : nil)
    }

    @Test func kindComesFromTheName() {
        #expect(DeviceKind(name: "Sibhi's iPhone") == .iphone)
        #expect(DeviceKind(name: "iPad") == .iphone)
        #expect(DeviceKind(name: "Web · Chrome") == .browser)
        #expect(DeviceKind(name: "Safari on Mac") == .browser)
        #expect(DeviceKind(name: "Mystery") == .other)
        #expect(DeviceKind.iphone.symbol == "iphone.gen3")
        #expect(DeviceKind.browser.symbol == "globe")
    }

    @Test func listsActiveDevicesNewestFirstSayingHowEachGotThere() {
        let rows = DeviceList.rows([
            device("a", "Old phone", at: day(1)),
            device("b", "Web · Chrome", at: day(10), account: true),
            device("c", "Gone", at: day(12), revoked: true),
            device("d", "No date", account: true),
            device("e", "iPhone 17", at: day(3), account: true),
        ], calendar: utc)
        #expect(rows.map(\.id) == ["b", "e", "a", "d"])
        #expect(rows[0].line == "On your account · added 10 Nov 2026")
        #expect(rows[0].kind == .browser && rows[0].viaAccount)
        #expect(rows[2].line == "Added 1 Nov 2026" && !rows[2].viaAccount)
        #expect(rows[3].line == "On your account")
        #expect(DeviceList.rows([device("x", "Phone")], calendar: utc)[0].line == "Added earlier")
    }

    @Test func noCopyTalksOfPairingOrCodes() {
        let texts = [
            DeviceList.emptyLine(accountEmail: "me@x.org"), DeviceList.emptyLine(accountEmail: nil),
            DeviceList.footnote(), DeviceList.askFootnote(email: "me@x.org"), DeviceList.removeMessage(name: "Phone"),
        ]
        for t in texts {
            #expect(!t.lowercased().contains("pair"))
            #expect(!t.lowercased().contains("qr"))
            #expect(!t.lowercased().contains("code"))
        }
        #expect(DeviceList.emptyLine(accountEmail: "me@x.org").contains("me@x.org"))
        #expect(DeviceList.emptyLine(accountEmail: "").contains("Sign in to Squeak on this Mac"))
        #expect(DeviceList.askFootnote(email: "me@x.org").contains("one click"))
    }

    @Test func watchTellsOnceAboutANewWaitingAccountRequestAndSeedsSilently() {
        func status(_ ids: [(String, Bool)]) -> RemoteStatus {
            RemoteStatus(pending: ids.map { .init(id: $0.0, name: "Web", code: "123456", via: $0.1 ? "account" : nil, email: "a@b.c") })
        }
        var w = PendingRequestWatch()
        #expect(w.newlyWaiting(in: status([("a", true)])).isEmpty)
        #expect(w.newlyWaiting(in: status([("a", true), ("b", true), ("q", false)])).map(\.id) == ["b"])
        #expect(w.newlyWaiting(in: status([("a", true), ("b", true)])).isEmpty)
        // answered, then asking again with the same id is news again
        #expect(w.newlyWaiting(in: status([])).isEmpty)
        #expect(w.newlyWaiting(in: status([("b", true)])).map(\.id) == ["b"])
    }
}
