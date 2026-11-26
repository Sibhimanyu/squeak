import Foundation
import Testing
@testable import SqueakMacCore

private final class DevicesStub: HTTPTransport, @unchecked Sendable {
    var status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int = 200, body: String = "{}") { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

private func client(_ t: DevicesStub) -> PondsClient {
    PondsClient(host: NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, lineSource: { _ in AsyncThrowingStream { $0.finish() } }))
}

/// Settings › Your devices (#129): one account-wide list, removing a device removes it from every Pond, and a new device's
/// Ponds read "Connecting" until the Owner's Mac seals the key. No device ever appears inside a Pond.
@Suite("Your devices")
struct YourDevicesTests {
    private var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }

    @Test func theListIsTheAccountsDevicesWithThisOneMarked() async throws {
        let t = DevicesStub(body: #"{"devices":[{"deviceId":"d1","name":"Sibhi's MacBook","kind":"mac","createdAt":1790000000000,"lastSeenAt":1790000000000,"thisDevice":true},{"deviceId":"d2","name":"Sibhi's iPhone","kind":"iphone","lastSeenAt":1789000000000},{"name":"no id"}]}"#)
        let list = try #require(try await client(t).accountDevices())
        #expect(list.map(\.deviceId) == ["d1", "d2"])
        #expect(list[0].thisDevice && list[0].kind == .mac && !list[1].thisDevice && list[1].kind == .iphone)
        #expect(t.requests[0].url.path == "/native/ponds/account-devices" && t.requests[0].method == "GET")
        #expect(t.requests[0].headers["x-squeak-token"] == "tok")
        #expect(try await client(DevicesStub(status: 404, body: "{}")).accountDevices() == nil)
    }

    @Test func removeDeletesTheDeviceOnTheHostWhichRemovesItEverywhere() async throws {
        let t = DevicesStub()
        try await client(t).removeAccountDevice(id: "d2")
        #expect(t.requests[0].url.path == "/native/ponds/account-devices/remove" && t.requests[0].method == "POST")
        #expect(String(decoding: t.requests[0].body ?? Data(), as: UTF8.self).contains(#""deviceId":"d2""#))
        let refused = DevicesStub(status: 409, body: #"{"error":"This is the device you are using."}"#)
        await #expect(throws: NativeHostError.self) { try await client(refused).removeAccountDevice(id: "d1") }
    }

    @Test func thisDeviceComesFirstAndCannotRemoveItself() {
        let rows = YourDevices.rows([
            AccountDevice(deviceId: "a", name: "Old Mac", kind: .mac, lastSeenAt: Date(timeIntervalSince1970: 1_700_000_000)),
            AccountDevice(deviceId: "b", name: "Phone", kind: .iphone, lastSeenAt: Date(timeIntervalSince1970: 1_780_000_000)),
            AccountDevice(deviceId: "c", name: "This one", kind: .mac, lastSeenAt: Date(timeIntervalSince1970: 1_600_000_000), thisDevice: true),
            AccountDevice(deviceId: "d", name: "", kind: .web),
        ], calendar: utc)
        #expect(rows.map(\.id) == ["c", "b", "a", "d"])
        #expect(rows[0].line == "This Mac" && !rows[0].canRemove)
        #expect(rows[1].line == "iPhone \u{00B7} last seen 28 May 2026" && rows[1].canRemove)
        #expect(rows[3].name == "Browser" && rows[3].line == "Browser")
    }

    @Test func theConfirmSaysEveryPondAndNothingAboutPairing() {
        let text = YourDevices.removeMessage(name: "Sibhi's iPhone")
        #expect(text.contains("every Pond") && text.contains("Sibhi's iPhone"))
        for t in [text, YourDevices.footnote, YourDevices.subtitle] { #expect(!t.lowercased().contains("code") && !t.lowercased().contains("pair")) }
    }

    @Test func aNewDevicesPondReadsConnectingWithNothingToPress() throws {
        let pond = try JSONDecoder().decode(PondSummary.self, from: Data(#"{"id":"p1","name":"Greenroom","status":"pending","connecting":true,"ownerName":"Sibhi","statusLine":"Connecting: waiting for Sibhi’s Mac"}"#.utf8))
        #expect(pond.state == .pending && pond.connecting)
        let card = try #require(PondStates.card(for: pond))
        #expect(card.title == "Connecting" && card.line == "Connecting: waiting for Sibhi\u{2019}s Mac" && card.button == nil && card.tone == .waiting)
        #expect(PondStates.rowTitle(pond) == "Greenroom \u{00B7} Connecting")
        // an older host sends no statusLine: the app still says the same sentence
        let bare = try JSONDecoder().decode(PondSummary.self, from: Data(#"{"id":"p1","name":"G","status":"pending","connecting":true,"ownerName":"Sibhi"}"#.utf8))
        #expect(PondStates.card(for: bare)?.line == "Connecting: waiting for Sibhi\u{2019}s Mac")
        // an ordinary request to join still waits for approval, with its button
        let ordinary = try JSONDecoder().decode(PondSummary.self, from: Data(#"{"id":"p2","name":"H","status":"pending"}"#.utf8))
        #expect(!ordinary.connecting && PondStates.card(for: ordinary)?.title == "Waiting for approval" && PondStates.card(for: ordinary)?.button == nil)
    }
}
