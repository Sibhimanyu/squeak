import Foundation
import Testing
@testable import SqueakMacCore

@MainActor
private final class FakeAddon: AppAddon {
    let id: String
    var hostName: String { "Fake" }
    var providers: Set<String> { ["fake"] }
    let adapter: any HostAdapter
    init(id: String = "fake", adapter: any HostAdapter) { self.id = id; self.adapter = adapter }
    func sources(client: DaemonClient) -> AddonSources { AddonSources(adapters: [adapter], takesOver: ["fake"]) }
}

@Suite("Add-ons")
@MainActor
struct AddonTests {
    private func client(_ t: FakeTransport) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:9")!, transport: t, tokenProvider: { "tok" })
    }

    @Test func catalogueDecodesAndKeepsTheGoodEntries() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/addons", #"{"addons":[{"id":"conductor","name":"Conductor","blurb":"b","available":true,"enabled":false},{"nope":1},{"id":"x"}]}"#)
        let list = try #require(try await client(t).addons())
        #expect(list.map(\.id) == ["conductor", "x"])
        #expect(list[0] == AddonInfo(id: "conductor", name: "Conductor", blurb: "b", available: true, enabled: false))
        #expect(list[1].name == "x" && list[1].available && !list[1].enabled)
    }

    @Test func oldDaemonHasNoAddonRoutes() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/addons", status: 404, "{}")
        #expect(try await client(t).addons() == nil)
    }

    @Test func settingAnAddonSendsExactlyIdAndEnabled() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/addons", #"{"ok":true,"addons":[{"id":"conductor","name":"Conductor","enabled":true}]}"#)
        let list = try #require(try await client(t).setAddon(id: "conductor", enabled: true))
        #expect(list.first?.enabled == true)
        let post = try #require(await t.requests.first { $0.method == "POST" })
        let body = try #require(try JSONSerialization.jsonObject(with: post.body ?? Data()) as? [String: Any])
        #expect(Set(body.keys) == ["id", "enabled"] && body["id"] as? String == "conductor" && body["enabled"] as? Bool == true)
    }

    @Test func enabledAddonsSourcesJoinAndTakeOverTheirProviders() async {
        let t = FakeTransport()
        await t.json("GET", "/state", #"{"active":[{"key":"k1","agent":"claude","origin":"fake","state":"idle"},{"key":"k2","agent":"claude","origin":"terminal","state":"idle"}]}"#)
        let stub = FakeAdapter(id: "fake-adapter")
        let none = SessionSources.adapters(client: client(t))
        #expect(none.map(\.id) == ["daemon"])
        let adapters = SessionSources.adapters(client: client(t), addons: [FakeAddon(adapter: stub)])
        #expect(adapters.map(\.id) == ["fake-adapter", "daemon"])
    }

    @Test func theBrokerSwapsSourcesLive() async {
        let a = FakeAdapter(id: "a"), b = FakeAdapter(id: "b")
        await a.setSessions([makeSession("one")])
        await b.setSessions([makeSession("two")])
        let broker = Broker(adapters: [a], clock: FakeClock())
        await broker.refresh()
        #expect(await broker.sessions().map(\.key.hostSessionId) == ["one"])
        await broker.setAdapters([b])
        await broker.refresh()
        #expect(await broker.sessions().map(\.key.hostSessionId) == ["two"])
        #expect(await broker.healths().map(\.adapterId) == ["b"])
    }

    @Test func registryKeepsOneEntryPerId() {
        let registry = AddonRegistry()
        registry.register(app: FakeAddon(adapter: FakeAdapter(id: "x")))
        registry.register(app: FakeAddon(adapter: FakeAdapter(id: "y")))
        #expect(registry.apps.count == 1 && registry.app(id: "fake") != nil && registry.app(id: "other") == nil)
    }

    @Test func finishedNotificationsCallTheOldConductorValueReplyable() throws {
        #expect(NotifyFinished(rawValue: "conductor") == .replyable)
        #expect(NotifyFinished(rawValue: "replyable") == .replyable)
        #expect(NotifyFinished.replyable.rawValue == "replyable" && NotifyFinished.replyable.title == "Chats you can reply to")
        let s = try JSONDecoder().decode(ChannelNotify.self, from: Data(#"{"finished":"conductor"}"#.utf8))
        #expect(s.finished == .replyable)
        #expect(try JSONDecoder().decode(ChannelNotify.self, from: Data("{}".utf8)).finished == .replyable)
    }
}
