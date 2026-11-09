import Foundation
import Testing
@testable import SqueakMacCore

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func chat(_ id: String, _ title: String, repo: String = "squeak", cwd: String = "/w/squeak/mallard", branch: String = "me/mallard",
                  agent: String = "claude", state: SessionState = .finished, ago: TimeInterval = 60) -> HostSession {
    HostSession(key: SessionKey(provider: "conductor", hostSessionId: id), title: title, repoName: repo, branch: branch, cwd: cwd,
                agent: agent, state: state, lastActivityAt: now.addingTimeInterval(-ago), alive: true)
}

private let sessions = [
    chat("1", "Queue pending messages", state: .working, ago: 30),
    chat("2", "Fix stale finish detection", ago: 3600),
    chat("3", "Rotate the signing key", repo: "orchard", cwd: "/w/orchard/kestrel", branch: "me/kestrel", agent: "codex", state: .blocked, ago: 600),
]

@Suite("Command palette")
struct CommandPaletteTests {
    let all = CommandPalette.items(sessions: sessions, context: PaletteContext(chat: sessions[0], chatIsWorking: true, canMakeWorkspace: true))

    @Test func emptyQueryShowsGroupsInOrderNewestFirst() {
        let r = CommandPalette.results(query: "", items: all)
        #expect(r.map(\.group) == [.chats, .workspaces, .actions])
        #expect(r[0].items.map(\.title) == ["Queue pending messages", "Rotate the signing key", "Fix stale finish detection"])
    }

    @Test func recentsComeFirstWhenEmpty() {
        var rec = PaletteRecents()
        rec.record("action:toggleInspector")
        rec.record("chat:conductor:local::2")
        let r = CommandPalette.results(query: "", items: all, recents: rec.ids)
        #expect(r[0].group == .recent)
        #expect(r[0].items.map(\.title) == ["Fix stale finish detection", "Toggle inspector"])
        #expect(!r[1].items.contains { $0.title == "Fix stale finish detection" })
        rec.record("action:toggleInspector")
        #expect(rec.ids.first == "action:toggleInspector" && rec.ids.count == 2)
    }

    @Test func fuzzyMatchesSubsequenceAndRanksSubstringsFirst() {
        let r = CommandPalette.results(query: "stfin", items: all)
        #expect(r.first?.items.first?.title == "Fix stale finish detection")
        let sub = CommandPalette.results(query: "queue", items: all)
        #expect(sub.first?.items.first?.title == "Queue pending messages")
        #expect(CommandPalette.results(query: "zzqx", items: all).isEmpty)
    }

    @Test func matchesProjectAndWorkspaceNames() {
        let r = CommandPalette.results(query: "orchard", items: all)
        #expect(r.first { $0.group == .chats }?.items.map(\.title) == ["Rotate the signing key"])
        #expect(r.contains { $0.group == .workspaces })
        let ws = CommandPalette.results(query: "mallard", items: all).first { $0.group == .workspaces }
        #expect(ws?.items.first?.title == "mallard")
    }

    @Test func workspaceRowOpensItsNewestChat() {
        let ws = all.first { $0.id.hasPrefix("ws:squeak") }
        #expect(ws?.target == .workspace(newestChat: sessions[0].key))
    }

    @Test func greaterThanListsActionsOnly() {
        let r = CommandPalette.results(query: ">", items: all)
        #expect(r.map(\.group) == [.actions])
        let stop = CommandPalette.results(query: ">stop", items: all)
        #expect(stop.first?.items.first?.target == .action(.stopChat))
    }

    @Test func stateAndAgentWordsFilterChats() {
        let waiting = CommandPalette.results(query: "waiting", items: all)
        #expect(waiting.flatMap(\.items).map(\.title) == ["Rotate the signing key"])
        let codex = CommandPalette.results(query: "codex key", items: all)
        #expect(codex.flatMap(\.items).map(\.title) == ["Rotate the signing key"])
    }

    @Test func actionsAreOfferedOnlyWhenTheyWouldWork() {
        func titles(_ c: PaletteContext) -> [String] {
            CommandPalette.items(sessions: [], context: c).filter { $0.group == .actions }.map(\.title)
        }
        let bare = titles(PaletteContext())
        #expect(bare.contains("New chat") && bare.contains("Open settings"))
        for t in ["Stop current chat", "Approve current request", "Copy branch name", "Reveal folder in Finder", "Open in Conductor",
                  "Commit and push", "Create pull request", "New workspace"] { #expect(!bare.contains(t)) }
        let full = titles(PaletteContext(
            chat: sessions[0], chatIsNative: true, chatWaitsOnApproval: true, chatIsWorking: true, canOpenInConductor: true,
            canCommitPush: true, canCreatePR: true, canMakeWorkspace: true))
        for t in ["Stop current chat", "Approve current request", "Deny current request", "Copy branch name", "Reveal folder in Finder",
                  "Open in Conductor", "Commit and push", "Create pull request", "New workspace"] { #expect(full.contains(t)) }
        // A Conductor chat's approval is answered in Conductor, never from here.
        let host = titles(PaletteContext(chat: sessions[0], chatIsNative: false, chatWaitsOnApproval: true))
        #expect(!host.contains("Approve current request"))
    }

    @Test func actionRowsCarryTheRegistryKeycap() {
        let r = CommandPalette.results(query: "toggle sidebar", items: all)
        #expect(r.first?.items.first?.shortcut == "⌘B")
        let ns = all.first { $0.id == "action:newWorkspace" }
        #expect(ns?.shortcut == "⇧⌘N")
    }
}

@Suite("Shortcut registry")
struct ShortcutRegistryTests {
    @Test func everyIdHasOneEntryAndEveryAreaIsKnown() {
        for id in ShortcutID.allCases { #expect(ShortcutRegistry.all.filter { $0.id == id }.count == 1, "\(id)") }
        for e in ShortcutRegistry.all { #expect(ShortcutRegistry.areas.contains(e.area)) }
    }

    @Test func chordsDrawInMacOSOrder() {
        #expect(KeyChord("N", [.command, .shift]).display == "⇧⌘N")
        #expect(KeyChord("/", [.command, .option]).display == "⌥⌘/")
        #expect(KeyChord("Tab", [.control, .shift]).display == "⌃⇧Tab")
        #expect(ShortcutRegistry.keycap(.palette) == "⌘K")
    }

    @Test func overridesWinAndSearchFilters() {
        #expect(ShortcutRegistry.keycap(.palette, overrides: [.palette: [KeyChord("P", [.command, .shift])]]) == "⇧⌘P")
        let found = ShortcutRegistry.sections(matching: "terminal").flatMap(\.entries).map(\.id)
        #expect(found.contains(.toggleTerminal) && !found.contains(.send))
        #expect(ShortcutRegistry.sections().map(\.area) == ShortcutRegistry.areas)
    }

    @Test func noTwoShortcutsShareAChordInTheSameArea() {
        // Cards and Composer reuse ↵ on purpose (a card only takes it while it waits); everything else must be unique.
        for area in ShortcutRegistry.areas where area != "Cards" {
            let chords = ShortcutRegistry.all.filter { $0.area == area }.flatMap(\.chords)
            #expect(Set(chords).count == chords.count, "\(area)")
        }
    }
}
