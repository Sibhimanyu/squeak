import Foundation
import Testing
@testable import Conductor
@testable import SqueakMacCore

@Suite("Conductor add-on")
@MainActor
struct ConductorAddonTests {
    private func client(_ t: FakeTransport) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:9")!, transport: t, tokenProvider: { "tok" })
    }

    private func addon(_ t: FakeTransport, dbPath: String = "/nonexistent/c.db") -> ConductorAddon {
        ConductorAddon(client: client(t), database: ConductorDatabase(path: dbPath))
    }

    private let workspaces = #"{"linked":true,"workspaces":[{"id":"w1","repo":"squeak","name":"ushuaia","branch":"main","chats":2,"picked":true},{"id":"w2","repo":"squeak","name":"oslo","state":"archived","chats":0,"picked":false}]}"#

    @Test func describesItselfToCore() {
        let a = addon(FakeTransport())
        #expect(a.id == "conductor" && a.hostName == "Conductor" && a.providers == ["conductor"] && a.mark == .conductor)
        #expect(a.watchedPaths.last?.hasSuffix("conductor.db-wal") == true)
        #expect(a.adapterNames == ["conductor-local": "Conductor database"])
        #expect(a.uninstallNote?.contains("Conductor") == true)
    }

    @Test func pageListsWorkspacesGroupedByRepoAndTogglesThroughTheDaemon() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/conductor/workspaces", workspaces)
        let a = addon(t)
        #expect(a.page?.choices.isEmpty == true && a.page?.headline == nil)  // before the first reading
        await a.refreshPage()
        let page = try #require(a.page)
        #expect(page.choicesTitle == "Workspaces" && page.choices.map(\.id) == ["w1", "w2"])
        #expect(page.choices.allSatisfy { $0.group == "squeak" })
        #expect(page.choices[0].isOn && page.choices[0].subtitle == "main · 2 chats" && !page.choices[1].isOn && page.choices[1].archived)

        await t.json("POST", "/control/conductor/workspaces", workspaces.replacingOccurrences(of: #""id":"w2","repo":"squeak","name":"oslo","state":"archived","chats":0,"picked":false"#, with: #""id":"w2","repo":"squeak","name":"oslo","state":"archived","chats":0,"picked":true"#))
        await page.choices[1].toggle(true)
        #expect(a.page?.choices[1].isOn == true)
        let post = try #require(await t.requests.first { $0.method == "POST" })
        let body = try #require(try JSONSerialization.jsonObject(with: post.body ?? Data()) as? [String: Any])
        #expect(body["id"] as? String == "w2" && body["picked"] as? Bool == true && body.count == 2)
    }

    @Test func aDaemonThatCannotListSaysSoInsteadOfShowingNothing() async {
        let t = FakeTransport()
        await t.json("GET", "/control/conductor/workspaces", status: 404, "{}")
        let a = addon(t)
        await a.refreshPage()
        #expect(a.page?.problem?.contains("needs updating") == true)
    }

    @Test func connectionRowSaysWhatTheDatabaseIs() {
        let missing = ConductorAddon.databaseRow(exists: false, localHealth: nil)
        #expect(missing.value == "Missing" && missing.level == .problem)
        let ok = ConductorAddon.databaseRow(exists: true, localHealth: AdapterHealth(adapterId: "conductor-local", status: .connected))
        #expect(ok.value == "Readable" && ok.level == .ok)
        #expect(ConductorAddon.databaseRow(exists: true, localHealth: nil).value == "Checking")
        #expect(ConductorAddon.databaseRow(exists: true, localHealth: AdapterHealth(adapterId: "x", status: .degraded("locked"))).detail == "locked")
    }

    @Test func noDatabaseMeansTheDaemonServesConductorChatsAndNoLocalReaderRuns() {
        let s = addon(FakeTransport()).sources(client: client(FakeTransport()))
        #expect(s.adapters.isEmpty && s.takesOver.isEmpty && s.opener != nil)
    }

    @Test func aDatabaseMeansTheLocalReaderTakesOverConductorChats() throws {
        let f = try ConductorFixture()
        let s = addon(FakeTransport(), dbPath: f.database.path).sources(client: client(FakeTransport()))
        #expect(s.adapters.map(\.id) == ["conductor-local"] && s.takesOver == ["conductor"])
    }
}
