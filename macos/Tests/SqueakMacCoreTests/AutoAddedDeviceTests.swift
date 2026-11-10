import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct AutoAddedDeviceTests {
    private func status(_ ids: [(String, Bool?)], revoked: Set<String> = []) -> RemoteStatus {
        RemoteStatus(devices: ids.map {
            .init(id: $0.0, name: "Phone \($0.0)", revokedAt: revoked.contains($0.0) ? Date() : nil, via: $0.1 == nil ? nil : "account", addedAutomatically: $0.1)
        })
    }

    @Test func decodesNewFields() throws {
        let json = #"{"devices":[{"id":"a","name":"Mac","via":"account","addedAutomatically":true},{"id":"b","name":"Old"}]}"#
        let s = try JSONDecoder().decode(RemoteStatus.self, from: Data(json.utf8))
        #expect(s.devices[0].isViaAccount && s.devices[0].addedAutomatically == true)
        #expect(!s.devices[1].isViaAccount && s.devices[1].addedAutomatically == nil)
        let a = AccountState.decode(Data(#"{"linked":true,"email":"a@b.c","askOwnDevices":true}"#.utf8))
        #expect(a?.askOwnDevices == true)
        #expect(AccountState.decode(Data(#"{"linked":true}"#.utf8))?.askOwnDevices == nil)
    }

    @Test func firstLoadSeedsWithoutNotifying() {
        var w = AutoAddedDeviceWatch()
        #expect(w.newlyAdded(in: status([("a", true)])).isEmpty)
        #expect(w.newlyAdded(in: status([("a", true)])).isEmpty)
    }

    @Test func notifiesOnceForANewAutoAddedDevice() {
        var w = AutoAddedDeviceWatch()
        _ = w.newlyAdded(in: status([("a", true)]))
        let first = w.newlyAdded(in: status([("a", true), ("b", true), ("c", false), ("d", nil)]))
        #expect(first.map(\.id) == ["b"])
        #expect(w.newlyAdded(in: status([("a", true), ("b", true), ("c", false), ("d", nil)])).isEmpty)
    }

    @Test func revokedDevicesAreIgnored() {
        var w = AutoAddedDeviceWatch()
        _ = w.newlyAdded(in: status([]))
        #expect(w.newlyAdded(in: status([("x", true)], revoked: ["x"])).isEmpty)
    }
}
