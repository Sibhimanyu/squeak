import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ThreadArchiveTests {
    private func chat(_ id: String, title: String = "", state: SessionState = .idle, archived: Date? = nil, repo: String = "squeak", squeak: Bool = true) -> HostSession {
        HostSession(
            key: SessionKey(provider: squeak ? "claude-squeak" : "claude", workspaceId: nil, hostSessionId: squeak ? "squeak-native:\(id)" : id),
            title: title, repoName: repo, state: state, archivedAt: archived)
    }

    @Test func archiveIsOfferedOnlyForAnIdleSqueakChatInTheList() {
        #expect(ThreadArchive.canArchive(chat("a")))
        #expect(ThreadArchive.canArchive(chat("a", state: .finished)))
        #expect(!ThreadArchive.canArchive(chat("a", state: .working)))
        #expect(!ThreadArchive.canArchive(chat("a", state: .blocked)))
        #expect(!ThreadArchive.canArchive(chat("a", archived: Date())))
        #expect(!ThreadArchive.canArchive(chat("a", squeak: false)))
    }

    @Test func unarchiveIsOfferedOnlyForAnArchivedSqueakChat() {
        #expect(ThreadArchive.canUnarchive(chat("a", archived: Date())))
        #expect(!ThreadArchive.canUnarchive(chat("a")))
        #expect(!ThreadArchive.canUnarchive(chat("a", archived: Date(), squeak: false)))
    }

    @Test func listsDropArchivedAndTheArchivedViewIsNewestFirst() {
        let old = Date(timeIntervalSince1970: 1_000), new = Date(timeIntervalSince1970: 2_000)
        let all = [chat("a", title: "Alpha", archived: old), chat("b", title: "Beta"), chat("c", title: "Gamma", archived: new), chat("d", title: "Delta", archived: new, repo: "other")]
        #expect(ThreadArchive.listed(all).map { $0.label } == ["Beta"])
        #expect(ThreadArchive.archived(all).map { $0.label } == ["Delta", "Gamma", "Alpha"])
        #expect(ThreadArchive.archived(all, inProject: "squeak").map { $0.label } == ["Gamma", "Alpha"])
    }

    @Test func entryShowsOnlyWithACount() {
        #expect(ThreadArchive.entryTitle(count: 0) == nil)
        #expect(ThreadArchive.entryTitle(count: 3) == "Archived (3)")
    }

    @Test func anArchivedChatIsReadOnly() {
        #expect(ThreadArchive.composerReplaced(chat("a", archived: Date())))
        #expect(!ThreadArchive.composerReplaced(chat("a")))
    }
}
