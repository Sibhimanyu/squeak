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
                  "Commit and push", "Create pull request", "New stream"] { #expect(!bare.contains(t)) }
        let full = titles(PaletteContext(
            chat: sessions[0], chatIsNative: true, chatWaitsOnApproval: true, chatIsWorking: true, canOpenInHost: true, hostName: "Conductor",
            canCommitPush: true, canCreatePR: true, canMakeWorkspace: true))
        for t in ["Stop current chat", "Approve current request", "Deny current request", "Copy branch name", "Reveal folder in Finder",
                  "Open in Conductor", "Commit and push", "Create pull request", "New stream"] { #expect(full.contains(t)) }
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

    @Test func gitActionsCarryTheirKeysOnlyForSqueakChats() {
        func row(_ id: String, native: Bool) -> PaletteItem? {
            CommandPalette.items(sessions: [], context: PaletteContext(
                chat: sessions[0], chatIsNative: native, canCommitPush: true, canCreatePR: true))
                .first { $0.id == id }
        }
        #expect(row("action:commitPush", native: true)?.shortcut == "⇧⌘Y")
        #expect(row("action:createPR", native: true)?.shortcut == "⇧⌘P")
        #expect(row("action:createPR", native: false)?.shortcut == nil)
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

    @Test func gitKeysAndInspectorTabsAreListed() {
        #expect(ShortcutRegistry.keycap(.gitCreatePR) == "⇧⌘P")
        #expect(ShortcutRegistry.keycap(.gitCommitPush) == "⇧⌘Y")
        #expect(ShortcutRegistry.keycap(.gitMerge) == "⇧⌘M")
        #expect(ShortcutRegistry.keycap(.gitFixErrors) == "⇧⌘X")
        #expect(ShortcutRegistry.keycap(.gitReview) == "⇧⌘R")
        #expect(ShortcutRegistry.keycap(.inspectorTabs) == "⌥⌘1–3")
        #expect(ShortcutRegistry.keycap(.gitPullLatest) == "⇧⌘L")
        #expect(ShortcutRegistry.keycap(.nextAttention) == "⌥⌘L" && ShortcutRegistry.keycap(.home) == "⇧⌘H")
        #expect(ShortcutRegistry.keycap(.zenMode) == "⇧⌘." && ShortcutRegistry.keycap(.stop) == "⌘.")
        // Every git row matches the key GitActionKind binds (GitShortcuts), so the sheet cannot drift from the window.
        for (id, kind) in [(ShortcutID.gitCreatePR, GitActionKind.createPR), (.gitCommitPush, .commitPush), (.gitMerge, .merge),
                           (.gitFixErrors, .fixErrors), (.gitReview, .review), (.gitPullLatest, .pullLatest)] {
            #expect(ShortcutRegistry.entry(id)?.chords == [KeyChord(String(kind.shortcutKey!).uppercased(), [.command, .shift])])
        }
        // Keys that nothing binds are not listed.
        let titles = ShortcutRegistry.all.map(\.title)
        for gone in ["Quick open", "Find in chat"] { #expect(!titles.contains(gone)) }
    }

    @Test func noTwoShortcutsShareAChordInTheSameArea() {
        // Cards and Composer reuse ↵ on purpose (a card only takes it while it waits); everything else must be unique.
        for area in ShortcutRegistry.areas where area != "Cards" {
            let chords = ShortcutRegistry.all.filter { $0.area == area }.flatMap(\.chords)
            #expect(Set(chords).count == chords.count, "\(area)")
        }
    }
}

struct ShortcutCoverageTests {
    @Test func noChordIsBoundTwiceInOneScope() {
        #expect(ShortcutRegistry.duplicates().isEmpty, "\(ShortcutRegistry.duplicates())")
    }

    @Test func theCommonActionsHaveChords() {
        let expected: [ShortcutID: String] = [
            .toggleSidebar: "⌘B", .toggleInspector: "⌥⌘B", .newTab: "⌘T", .closeTab: "⇧⌘W", .reopenTab: "⇧⌘T",
            .nextTab: "⌃Tab", .previousTab: "⌃⇧Tab", .home: "⇧⌘H", .palette: "⌘K", .focusComposer: "⌘L",
            .modelPicker: "⌘/", .effortPicker: "⇧⌘E", .attach: "⌘U", .stop: "⌘.", .gitCreatePR: "⇧⌘P",
            .gitCommitPush: "⇧⌘Y", .gitMerge: "⇧⌘M", .gitFixErrors: "⇧⌘X", .gitReview: "⇧⌘R", .gitPullLatest: "⇧⌘L",
            .diffView: "⇧⌘G", .toggleTerminal: "⌘J", .settings: "⌘,", .steer: "⌘↵", .send: "↵",
        ]
        for (id, keys) in expected { #expect(ShortcutRegistry.keycap(id) == keys, "\(id)") }
    }

    @Test func hintsNameTheControlAndItsKeys() {
        #expect(ShortcutRegistry.hint("Hide sidebar", .toggleSidebar) == "Hide sidebar  ⌘B")
        #expect(ShortcutRegistry.hint("Close tab", .closeTab) == "Close tab  ⇧⌘W")
    }

    @Test func tabsStepAndWrap() {
        #expect(ChatTabs.step(from: "b", in: ["a", "b", "c"], by: 1) == "c")
        #expect(ChatTabs.step(from: "c", in: ["a", "b", "c"], by: 1) == "a")
        #expect(ChatTabs.step(from: "a", in: ["a", "b", "c"], by: -1) == "c")
        #expect(ChatTabs.step(from: nil as String?, in: ["a", "b"], by: 1) == "a")
        #expect(ChatTabs.step(from: "a", in: [String](), by: 1) == nil)
    }

    /// DESIGN.md's keymap shows every chord the registry binds, so the two cannot drift apart.
    @Test func designKeymapListsEveryChord() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("DESIGN.md")
        let design = try String(contentsOf: url, encoding: .utf8)
        // A chord is listed in the keymap as drawn, or with ⌘⇧ for ⇧⌘ (the table has both spellings).
        func listed(_ chord: String) -> Bool {
            [chord, chord.replacingOccurrences(of: "⇧⌘", with: "⌘⇧"), chord.replacingOccurrences(of: "⌥⌘", with: "⌘⌥")]
                .contains { design.contains($0) }
        }
        for e in ShortcutRegistry.all where e.id != .inspectorTabs && e.id != .openSession {
            for c in e.chords where c.key.count == 1 || c.key == "Tab" {
                #expect(listed(c.display), "\(e.id.rawValue) \(c.display) is missing from DESIGN.md's keymap")
            }
        }
    }
}

struct ModelPickingTests {
    @Test func effortStepsAndWraps() {
        #expect(ModelPicking.nextLevel(after: "low", in: ["low", "high"]) == "high")
        #expect(ModelPicking.nextLevel(after: "high", in: ["low", "high"]) == "low")
        #expect(ModelPicking.nextLevel(after: nil, in: ["low", "high"]) == "low")
        #expect(ModelPicking.nextLevel(after: "x", in: []) == nil)
    }
}
