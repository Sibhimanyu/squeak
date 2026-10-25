import XCTest
import SqueakCore
@testable import SqueakUI

final class ConnectionStatusTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_792_400_000)
    let snapshot = try! JSONDecoder().decode(PhoneSnapshot.self, from: Data(
        #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T08:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#.utf8))

    private func read(mac: MacLiveness, route: ChannelRoute = .cloud, offline: Bool = false, aliveAt: Date? = nil) -> ConnectionStatus {
        ConnectionStatus.read(snapshot: snapshot, problem: nil, demo: false, lastFetch: now, mac: mac, route: route,
                              phoneOffline: offline, macAliveAt: aliveAt, now: now)
    }

    func testConnectedNamesTheRouteOnlyWhileTheMacAnswers() {
        let wifi = read(mac: .answering, route: .local)
        XCTAssertEqual(wifi.tone, .connected)
        XCTAssertTrue(wifi.healthy)
        XCTAssertTrue(wifi.text.hasPrefix("Connected · same Wi-Fi"))
        XCTAssertTrue(read(mac: .checking).text.hasPrefix("Connected · via cloud"))
        XCTAssertEqual(ConnectionStatus.routeText(.local, mac: .answering), "Connected · same Wi-Fi")
        XCTAssertEqual(ConnectionStatus.routeText(.cloud, mac: .checking), "Connected · via cloud")
    }

    func testASilentMacIsNotConnectedAndSaysWhenItWasHeard() {
        let since = now.addingTimeInterval(-12 * 60)
        let status = read(mac: .silent(since: since), route: .local)
        XCTAssertEqual(status.tone, .notConnected)
        XCTAssertFalse(status.healthy)
        XCTAssertEqual(status.text, "Mac not answering, maybe asleep · last heard 12m ago")
        XCTAssertEqual(ConnectionStatus.routeText(.local, mac: .silent(since: since), now: now), "Not connected · last heard 12m ago")
    }

    func testAnUnknownMacIsUnverifiedNeverGreen() {
        let status = read(mac: .unknown)
        XCTAssertEqual(status.tone, .unverified)
        XCTAssertFalse(status.healthy)
        XCTAssertTrue(status.text.hasPrefix("Unverified"))
        XCTAssertFalse(ConnectionStatus.routeText(.cloud, mac: .unknown).hasPrefix("Connected"))
    }

    func testThePhonesOwnNetworkOutranksEverything() {
        let aliveAt = now.addingTimeInterval(-12 * 60)
        for mac in [MacLiveness.answering, .checking, .unknown, .silent(since: aliveAt)] {
            let status = read(mac: mac, offline: true, aliveAt: aliveAt)
            XCTAssertEqual(status.tone, .notConnected)
            XCTAssertFalse(status.healthy)
            XCTAssertEqual(status.text, "No internet on this iPhone · last heard from your Mac 12m ago")
        }
        // Never heard from a Mac: no invented time.
        let none = ConnectionStatus.read(snapshot: nil, problem: nil, demo: false, phoneOffline: true, now: now)
        XCTAssertEqual(none.text, "No internet on this iPhone")
        // The demo has no network to lose.
        XCTAssertTrue(ConnectionStatus.read(snapshot: nil, problem: nil, demo: true, phoneOffline: true, now: now).healthy)
    }

    func testTransitions() {
        let aliveAt = now.addingTimeInterval(-5)
        // Phone offline, then back: the Mac gets its open grace (checking) rather than reading silent at once.
        XCTAssertEqual(read(mac: .answering, offline: true, aliveAt: aliveAt).tone, .notConnected)
        let back = MacLiveness.read(aliveAt: now.addingTimeInterval(-300), lookingSince: now.addingTimeInterval(-1), now: now)
        XCTAssertEqual(back, .checking)
        XCTAssertEqual(read(mac: back).tone, .connected)
        // Mac silent, then answers again.
        let old = now.addingTimeInterval(-300)
        let silent = MacLiveness.read(aliveAt: old, lookingSince: now.addingTimeInterval(-60), now: now)
        XCTAssertEqual(silent, .silent(since: old))
        XCTAssertEqual(read(mac: silent).tone, .notConnected)
        let answering = MacLiveness.read(aliveAt: now.addingTimeInterval(-3), lookingSince: now.addingTimeInterval(-60), now: now)
        XCTAssertEqual(answering, .answering)
        XCTAssertEqual(read(mac: answering).tone, .connected)
        // A quiet Mac pinged every 10 s is never silent: the newest answer is at most ~one ping plus its gap old.
        XCTAssertEqual(MacLiveness.read(aliveAt: now.addingTimeInterval(-20), lookingSince: nil, now: now), .answering)
    }
}
