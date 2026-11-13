import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ArchivedPageTests {
    private func t(_ n: Double) -> Date { Date(timeIntervalSince1970: n) }

    private func thread(_ id: String, _ title: String, pond: String?, archived: Date?, provider: String = "claude-squeak") -> HostSession {
        HostSession(
            key: SessionKey(provider: provider, workspaceId: nil, hostSessionId: id), title: title, repoName: pond, state: .idle, archivedAt: archived)
    }

    @Test func groupsByPondNewestArchivedFirstAndThreadsNewestFirst() {
        let sessions = [
            thread("a", "Alpha", pond: "squeak", archived: t(100)),
            thread("b", "Beta", pond: "squeak", archived: t(300)),
            thread("c", "Gamma", pond: "farm", archived: t(200), provider: "conductor"),
            thread("d", "Live", pond: "squeak", archived: nil),
        ]
        let groups = ArchivedPage.groups(sessions: sessions)
        #expect(groups.map(\.pond) == ["squeak", "farm"])
        #expect(groups[0].entries.map(\.title) == ["Beta", "Alpha"])
        #expect(groups[1].entries.map(\.title) == ["Gamma"])
    }

    @Test func tiesGoByTitleAndAPondWithNoNameIsOther() {
        let sessions = [thread("a", "Zed", pond: nil, archived: t(5)), thread("b", "Able", pond: " ", archived: t(5))]
        let groups = ArchivedPage.groups(sessions: sessions)
        #expect(groups.map(\.pond) == ["Other"])
        #expect(groups[0].entries.map(\.title) == ["Able", "Zed"])
    }

    @Test func sharedPondThreadsYouHidSitInTheirPondByHideTime() {
        let hide = SharedThreadHide(threadId: "x1", pondId: "p1", pondName: "squeak", title: "Their thread", hiddenAt: t(500))
        let groups = ArchivedPage.groups(sessions: [thread("a", "Mine", pond: "squeak", archived: t(100))], shared: [hide])
        #expect(groups.count == 1)
        #expect(groups[0].entries.map(\.title) == ["Their thread", "Mine"])
        #expect(groups[0].entries[0].target == .shared(pondId: "p1", threadId: "x1"))
        #expect(groups[0].entries[1].target == .session(SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: "a")))
    }

    @Test func searchMatchesEveryWordInTheTitleOrThePond() {
        let sessions = [
            thread("a", "Fix the login", pond: "squeak", archived: t(1)),
            thread("b", "Fix billing", pond: "farm", archived: t(2)),
        ]
        #expect(ArchivedPage.groups(sessions: sessions, query: "FIX").flatMap(\.entries).count == 2)
        #expect(ArchivedPage.groups(sessions: sessions, query: "fix login").flatMap(\.entries).map(\.title) == ["Fix the login"])
        #expect(ArchivedPage.groups(sessions: sessions, query: "farm").flatMap(\.entries).map(\.title) == ["Fix billing"])
        #expect(ArchivedPage.groups(sessions: sessions, query: "nothing here").isEmpty)
    }

    @Test func countsEveryArchivedThreadAndEveryHide() {
        let hide = SharedThreadHide(threadId: "x", pondId: "p", pondName: "n", title: "t", hiddenAt: t(1))
        #expect(ArchivedPage.count(sessions: [thread("a", "A", pond: "p", archived: t(1)), thread("b", "B", pond: "p", archived: nil)], shared: [hide]) == 2)
        #expect(ArchivedPage.count(sessions: [], shared: []) == 0)
    }

    @Test func hidesKeepTheFirstTimeAndRoundTrip() throws {
        var hides = SharedThreadHides()
        hides.hide(SharedThreadHide(threadId: "x", pondId: "p", pondName: "n", title: "t", hiddenAt: t(1)))
        hides.hide(SharedThreadHide(threadId: "x", pondId: "p", pondName: "n", title: "t", hiddenAt: t(9)))
        #expect(hides.hiddenIds == ["x"] && hides.isHidden("x"))
        #expect(hides.all.first?.hiddenAt == t(1))
        let again = try JSONDecoder().decode(SharedThreadHides.self, from: JSONEncoder().encode(hides))
        #expect(again == hides)
        hides.unhide("x")
        #expect(hides.hiddenIds.isEmpty)
    }

    // MARK: The daemon's side

    @Test func theDaemonsArchivedListBecomesArchivedThreadsAndStaysOffTheActiveLists() throws {
        let json = """
        {"active":[{"key":"claude:a","state":"working","title":"Live"}],
         "others":[{"key":"claude:b","state":"finished","title":"Old"}],
         "archived":[{"key":"claude:c","state":"finished","title":"Away","archived":true,"archivedAt":"2026-11-13T10:00:00.000Z"}]}
        """
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
        #expect(state.sessions.map(\.key) == ["claude:a", "claude:b", "claude:c"])
        let mapped = state.sessions.map { DaemonAdapter.map($0) }
        #expect(mapped.map { $0.archivedAt != nil } == [false, false, true])
        #expect(ThreadArchive.listed(mapped).map(\.title) == ["Live", "Old"])
        #expect(ThreadArchive.archived(mapped).map(\.title) == ["Away"])
        #expect(ThreadArchive.kind(mapped[2]) == .fleet)
    }

    @Test func anOlderDaemonSendsNoArchivedListAndNothingIsArchived() throws {
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"active":[{"key":"claude:a","state":"idle"}]}"#.utf8))
        #expect(state.sessions.allSatisfy { $0.archivedAt == nil })
    }

    @Test func archiveThreadPostsStrictBodyAndMapsOutcomes() async {
        let ok = ArchiveStub(status: 200, body: #"{"ok":true}"#)
        #expect(await client(ok).archiveThread(sessionKey: "claude:a", archived: true) == .done)
        #expect(ok.requests.count == 1)
        #expect(ok.requests[0].method == "POST" && ok.requests[0].url.path == "/control/session/claude:a/archive")
        #expect((try? JSONSerialization.jsonObject(with: ok.requests[0].body ?? Data())) as? [String: Bool] == ["archived": true])
        let busy = ArchiveStub(status: 400, body: #"{"error":"Stop the chat before archiving it."}"#)
        #expect(await client(busy).archiveThread(sessionKey: "claude:a", archived: true) == .refused(reason: "Stop the chat before archiving it."))
        let old = ArchiveStub(status: 404, body: "not found")
        if case .failed(let reason) = await client(old).archiveThread(sessionKey: "claude:a", archived: false) {
            #expect(reason.contains("Update"))
        } else { Issue.record("expected failed") }
    }

    private func client(_ t: ArchiveStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }

    @Test func theChatMenuShortcutIsFreeAndNamed() {
        #expect(ShortcutRegistry.keycap(.archiveThread) == "\u{21E7}\u{2318}A")
        #expect(ShortcutRegistry.duplicates().isEmpty)
    }
}

private final class ArchiveStub: HTTPTransport, @unchecked Sendable {
    let status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int, body: String) { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}
