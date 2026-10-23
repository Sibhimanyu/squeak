import Foundation
import XCTest
@testable import SqueakCore

final class RouteMachineTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let url = URL(string: "http://192.168.1.20:5123")!

    func testStartsOnTheCloudAndProbesAtOnce() {
        let machine = RouteMachine()
        XCTAssertEqual(machine.route, .cloud)
        XCTAssertTrue(machine.shouldProbe(now: t0))
    }

    func testASuccessfulProbePrefersLocalAndHeartbeats() {
        var machine = RouteMachine()
        machine.probeSucceeded(url, now: t0)
        XCTAssertEqual(machine.route, .local)
        XCTAssertEqual(machine.endpoint, url)
        XCTAssertFalse(machine.shouldProbe(now: t0))
        XCTAssertFalse(machine.shouldHeartbeat(now: t0.addingTimeInterval(4)))
        XCTAssertTrue(machine.shouldHeartbeat(now: t0.addingTimeInterval(5)))
    }

    func testAFailedProbeWaitsThirtySecondsToTryAgain() {
        var machine = RouteMachine()
        machine.probeFailed(now: t0)
        XCTAssertFalse(machine.shouldProbe(now: t0.addingTimeInterval(29)))
        XCTAssertTrue(machine.shouldProbe(now: t0.addingTimeInterval(30)))
    }

    func testAnyFailedCallFallsBackAtOnceAndReprobesLater() {
        var machine = RouteMachine()
        machine.probeSucceeded(url, now: t0)
        machine.operationFailed(now: t0.addingTimeInterval(2))
        XCTAssertEqual(machine.route, .cloud)
        XCTAssertNil(machine.endpoint)
        XCTAssertFalse(machine.shouldProbe(now: t0.addingTimeInterval(31)))
        XCTAssertTrue(machine.shouldProbe(now: t0.addingTimeInterval(32)))
    }

    func testAFailedCallOnTheCloudChangesNothing() {
        var machine = RouteMachine()
        machine.operationFailed(now: t0)
        XCTAssertTrue(machine.shouldProbe(now: t0))
    }

    func testTwoMissedHeartbeatsGiveUpButOneDoesNot() {
        var machine = RouteMachine()
        machine.probeSucceeded(url, now: t0)
        machine.heartbeat(ok: false, now: t0.addingTimeInterval(5))
        XCTAssertEqual(machine.route, .local)
        machine.heartbeat(ok: true, now: t0.addingTimeInterval(10))
        machine.heartbeat(ok: false, now: t0.addingTimeInterval(15))
        XCTAssertEqual(machine.route, .local)
        machine.heartbeat(ok: false, now: t0.addingTimeInterval(20))
        XCTAssertEqual(machine.route, .cloud)
    }

    func testANewNetworkDropsLocalAndProbesAtOnce() {
        var machine = RouteMachine()
        machine.probeSucceeded(url, now: t0)
        machine.networkChanged(now: t0.addingTimeInterval(3))
        XCTAssertEqual(machine.route, .cloud)
        XCTAssertTrue(machine.shouldProbe(now: t0.addingTimeInterval(3)))
    }

    func testALearnedAddressIsTriedAtOnceOnlyFromTheCloud() {
        var machine = RouteMachine()
        machine.probeFailed(now: t0)
        machine.addressLearned(now: t0.addingTimeInterval(1))
        XCTAssertTrue(machine.shouldProbe(now: t0.addingTimeInterval(1)))
        var local = RouteMachine()
        local.probeSucceeded(url, now: t0)
        local.addressLearned(now: t0)
        XCTAssertEqual(local.route, .local)
    }

    func testComingBackOnScreenChecksALocalRouteSoon() {
        var machine = RouteMachine()
        machine.probeSucceeded(url, now: t0)
        machine.checkSoon(now: t0.addingTimeInterval(1))
        XCTAssertTrue(machine.shouldHeartbeat(now: t0.addingTimeInterval(1)))
    }
}

/// A scriptable backend standing in for the cloud or for the Mac.
final class FakeStore: ChannelBackend, @unchecked Sendable {
    let name: String
    var docs: [String: ChannelDocument] = [:]
    var failing: Error?
    var failDelete: Error?
    var log: [String] = []
    var eventStreams: [AsyncStream<ChannelEvent>.Continuation] = []
    init(_ name: String) { self.name = name }

    func get(_ path: String) async throws -> ChannelDocument? {
        log.append("get \(path)")
        if let failing { throw failing }
        return docs[path]
    }
    func set(_ path: String, _ document: ChannelDocument) async throws {
        log.append("set \(path)")
        if let failing { throw failing }
        docs[path] = document
    }
    func delete(_ path: String) async throws {
        log.append("delete \(path)")
        if let error = failDelete ?? failing { throw error }
        docs[path] = nil
    }
    func changes(_ path: String) -> AsyncStream<Void>? { nil }
    func documents(_ path: String) -> AsyncStream<DocumentChange>? { nil }
    func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>? {
        let (stream, continuation) = AsyncStream<ChannelEvent>.makeStream()
        eventStreams.append(continuation)
        return stream
    }
    func streamHealth() async -> [StreamHealth] { [StreamHealth(path: name)] }
}

final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_000_000)
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

final class FakeDiscovery: LocalDiscovery, @unchecked Sendable {
    var found: [URL] = []
    var calls = 0
    func candidates(tag: String) async -> [URL] { calls += 1; return found }
}

/// Answers every probe: 200 `null` while `up`, a refused connection otherwise.
final class ProbeTransport: HTTPTransport, @unchecked Sendable {
    var up = true
    var urls: [URL] = []
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        urls.append(request.url!)
        if !up { throw URLError(.cannotConnectToHost) }
        return (Data("null".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

final class RoutedBackendTests: XCTestCase {
    let channel = "AAAAAAAAAAAAAAAAAAAAAA"
    let mac = URL(string: "http://192.168.1.20:5123")!
    var clock: Clock!
    var cloud: FakeStore!
    var local: FakeStore!
    var discovery: FakeDiscovery!
    var probes: ProbeTransport!
    var router: LocalRouter!
    var backend: RoutedBackend!

    override func setUp() {
        clock = Clock(); cloud = FakeStore("cloud"); local = FakeStore("local"); discovery = FakeDiscovery(); probes = ProbeTransport()
        let (clock, local, probes) = (clock!, local!, probes!)
        router = LocalRouter(channelId: channel, tag: "tag", discovery: discovery, now: { clock.now },
                             probeTransport: { _ in probes }, makeBackend: { _ in local })
        backend = RoutedBackend(cloud: cloud, router: router)
    }

    private func path(_ kind: String, _ id: String) -> String { "channels/\(channel)/\(kind)/\(id)" }
    private func connect() async {
        discovery.found = [mac]
        await router.tick()
        let route = await router.route
        XCTAssertEqual(route, .local)
    }

    func testPrefersLocalOnceAProbeFindsTheMac() async throws {
        cloud.docs[path("state", "snapshot")] = ChannelDocument(box: "cloud")
        local.docs[path("state", "snapshot")] = ChannelDocument(box: "local")
        // Before any probe: the cloud.
        let before = try await backend.get(path("state", "snapshot"))
        XCTAssertEqual(before?.box, "cloud")
        await connect()
        let after = try await backend.get(path("state", "snapshot"))
        XCTAssertEqual(after?.box, "local")
        XCTAssertEqual(probes.urls.first?.absoluteString, "http://192.168.1.20:5123/channels/\(channel)/state/alive.json")
    }

    func testStaysOnTheCloudWhenNothingAnswersAndTriesAgainEveryThirtySeconds() async {
        discovery.found = [mac]
        probes.up = false
        await router.tick()
        let first = await router.route
        XCTAssertEqual(first, .cloud)
        XCTAssertEqual(discovery.calls, 1)
        clock.advance(20)
        await router.tick()
        XCTAssertEqual(discovery.calls, 1)
        clock.advance(11)
        probes.up = true
        await router.tick()
        XCTAssertEqual(discovery.calls, 2)
        let second = await router.route
        XCTAssertEqual(second, .local)
    }

    func testTriesTheAddressesFromTheMacsViewToo() async {
        await router.learn(hints: [URL(string: "http://10.0.0.4:5123")!])
        await router.tick()
        let route = await router.route
        XCTAssertEqual(route, .local)
        XCTAssertEqual(probes.urls.first?.host, "10.0.0.4")
    }

    func testAFailedLocalReadFallsBackToTheCloudAtOnce() async throws {
        cloud.docs[path("state", "snapshot")] = ChannelDocument(box: "cloud")
        await connect()
        local.failing = URLError(.timedOut)
        let document = try await backend.get(path("state", "snapshot"))
        XCTAssertEqual(document?.box, "cloud")
        let route = await router.route
        XCTAssertEqual(route, .cloud)
        // And the next call does not even try the Mac.
        local.log = []
        _ = try await backend.get(path("state", "snapshot"))
        XCTAssertTrue(local.log.isEmpty)
    }

    func testAMissedHeartbeatPairDropsToTheCloud() async {
        await connect()
        local.failing = URLError(.timedOut)
        clock.advance(5); await router.tick()
        var route = await router.route
        XCTAssertEqual(route, .local)
        clock.advance(5); await router.tick()
        route = await router.route
        XCTAssertEqual(route, .cloud)
    }

    func testANetworkChangeDropsLocalAndLooksAgainAtOnce() async {
        await connect()
        await router.networkChanged()
        var route = await router.route
        XCTAssertEqual(route, .cloud)
        await router.tick()
        route = await router.route
        XCTAssertEqual(route, .local)
    }

    /* ---------- commands: exactly one transport ---------- */

    func testACommandSentLocallyIsNotAlsoSentToTheCloud() async throws {
        await connect()
        try await backend.set(path("commands", "c1"), ChannelDocument(box: "b", sig: "s", device: "d"))
        XCTAssertEqual(local.log.filter { $0.hasPrefix("set") }.count, 1)
        XCTAssertTrue(cloud.log.isEmpty)
        // Taking it back goes where it went, and only there.
        try await backend.delete(path("commands", "c1"))
        XCTAssertEqual(local.log.last, "delete \(path("commands", "c1"))")
        XCTAssertTrue(cloud.log.isEmpty)
    }

    func testACommandThatNeverReachedTheMacGoesThroughTheCloud() async throws {
        await connect()
        local.failing = URLError(.cannotConnectToHost)
        try await backend.set(path("commands", "c1"), ChannelDocument(box: "b"))
        XCTAssertEqual(cloud.log, ["set \(path("commands", "c1"))"])
        // Nothing was sent, so nothing needs taking back.
        XCTAssertFalse(local.log.contains { $0.hasPrefix("delete") })
        let route = await router.route
        XCTAssertEqual(route, .cloud)
        // Withdrawing it now reaches only the cloud, where it went.
        local.failing = nil
        try await backend.delete(path("commands", "c1"))
        XCTAssertEqual(cloud.log.last, "delete \(path("commands", "c1"))")
    }

    func testAnAmbiguousLocalFailureTakesTheCommandBackBeforeTheCloudGetsIt() async throws {
        await connect()
        // The write may have landed: the Mac's copy is deleted first, and only then does the cloud get one.
        // A Mac whose writes time out while its deletes work.
        let flaky = FlakySetStore()
        let (clock, probes) = (clock!, probes!)
        let router = LocalRouter(channelId: channel, tag: "tag", discovery: discovery, now: { clock.now },
                                 probeTransport: { _ in probes }, makeBackend: { _ in flaky })
        let backend = RoutedBackend(cloud: cloud, router: router)
        await router.tick()
        try await backend.set(path("commands", "c9"), ChannelDocument(box: "b"))
        XCTAssertEqual(flaky.log, ["set \(path("commands", "c9"))", "delete \(path("commands", "c9"))"])
        XCTAssertEqual(cloud.log, ["set \(path("commands", "c9"))"])
    }

    func testIfTheMacCannotBeAskedToGiveTheCommandBackTheCloudNeverGetsIt() async throws {
        await connect()
        // Writes time out and so does the delete: the command may be sitting in the Mac's inbox, so it is not
        // sent again anywhere. The caller sees the failure, and its own withdraw logic takes over.
        local.failing = URLError(.timedOut)
        do {
            try await backend.set(path("commands", "c1"), ChannelDocument(box: "b"))
            XCTFail("sent a command that may already be running")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
        XCTAssertTrue(cloud.log.isEmpty)
    }

    func testWithdrawingACommandOfUnknownRouteReachesBothAndNeedsBoth() async throws {
        await connect()
        try await backend.delete(path("commands", "old"))
        XCTAssertEqual(local.log.last, "delete \(path("commands", "old"))")
        XCTAssertEqual(cloud.log.last, "delete \(path("commands", "old"))")
        cloud.failing = URLError(.notConnectedToInternet)
        do { try await backend.delete(path("commands", "old")); XCTFail("claimed it was gone from the cloud") } catch {}
    }

    func testPairingAndMediaAreTheCloudsAlone() async throws {
        await connect()
        try await backend.set(path("pairing", "phone"), ChannelDocument(box: "b"))
        _ = try await backend.get(path("media", "x-0"))
        XCTAssertTrue(local.log.isEmpty)
        XCTAssertEqual(cloud.log.count, 2)
    }

    func testAResultReadLocallyIsClearedLocallyWithoutWaitingOnTheCloud() async throws {
        await connect()
        try await backend.delete(path("results", "r1"))
        XCTAssertEqual(local.log.last, "delete \(path("results", "r1"))")
        XCTAssertTrue(cloud.log.isEmpty)
    }

    /* ---------- streams follow the route ---------- */

    func testAStreamMovesToTheCloudWhenTheLocalOneDrops() async throws {
        await connect()
        let stream = try XCTUnwrap(backend.events(in: "channels/\(channel)/state", documents: ["snapshot"]))
        var iterator = stream.makeAsyncIterator()
        // The local stream is the one opened first.
        try await waitUntil { !self.local.eventStreams.isEmpty }
        local.eventStreams[0].yield(.connected)
        let first = await iterator.next()
        XCTAssertEqual(first, .connected)
        XCTAssertTrue(cloud.eventStreams.isEmpty)
        // It drops: the route goes back to the cloud and the stream is now the cloud's.
        local.eventStreams[0].yield(.dropped)
        let dropped = await iterator.next()
        XCTAssertEqual(dropped, .dropped)
        try await waitUntil { !self.cloud.eventStreams.isEmpty }
        cloud.eventStreams[0].yield(.document("snapshot", .refetch))
        let next = await iterator.next()
        XCTAssertEqual(next, .document("snapshot", .refetch))
        let route = await router.route
        XCTAssertEqual(route, .cloud)
    }

    func testAStreamStartedOnTheCloudMovesToTheMacWhenItIsFound() async throws {
        let stream = try XCTUnwrap(backend.events(in: "channels/\(channel)/state", documents: ["snapshot"]))
        var iterator = stream.makeAsyncIterator()
        try await waitUntil { !self.cloud.eventStreams.isEmpty }
        cloud.eventStreams[0].yield(.heard)
        let heard = await iterator.next()
        XCTAssertEqual(heard, .heard)
        await connect()
        try await waitUntil { !self.local.eventStreams.isEmpty }
        local.eventStreams[0].yield(.connected)
        let connected = await iterator.next()
        XCTAssertEqual(connected, .connected)
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition())
    }
}

/// A Mac whose writes time out (they may or may not have landed) but whose deletes work.
final class FlakySetStore: ChannelBackend, @unchecked Sendable {
    var log: [String] = []
    func get(_ path: String) async throws -> ChannelDocument? { nil }
    func set(_ path: String, _ document: ChannelDocument) async throws { log.append("set \(path)"); throw URLError(.timedOut) }
    func delete(_ path: String) async throws { log.append("delete \(path)") }
    func changes(_ path: String) -> AsyncStream<Void>? { nil }
    func documents(_ path: String) -> AsyncStream<DocumentChange>? { nil }
    func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>? { nil }
    func streamHealth() async -> [StreamHealth] { [] }
}
