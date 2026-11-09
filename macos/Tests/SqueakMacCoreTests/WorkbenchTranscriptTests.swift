import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct WorkbenchTranscriptTests {
    private func step(_ kind: String, _ text: String, _ s: Double? = nil) -> ActivityStep {
        ActivityStep(kind: kind, text: text, at: s.map { Date(timeIntervalSince1970: 1_000 + $0) })
    }

    @Test func toolLabelsSplitVerbAndTarget() {
        #expect(ToolCallLabel.preview("Read store.ts") == ToolCallPreview(kind: .read, verb: "Read", target: "store.ts", meta: nil))
        #expect(ToolCallLabel.preview("Edit a file").kind == .edit)
        #expect(ToolCallLabel.preview("Write x.md").verb == "Write")
        let search = ToolCallLabel.preview("Search for \"queue\"")
        #expect(search.kind == .search && search.target == "\"queue\"")
        #expect(ToolCallLabel.preview("Search the web for \"swift\"").target == "\"swift\"")
        #expect(ToolCallLabel.preview("Run npm test").target == "npm test")
        #expect(ToolCallLabel.preview("Fetch example.com").kind == .fetch)
        #expect(ToolCallLabel.preview("Update the plan").kind == .plan)
    }

    @Test func bashDescriptionIsACommand() {
        let p = ToolCallLabel.preview("Build the app")
        #expect(p.kind == .run && p.verb == "Run" && p.target == "Build the app")
    }

    @Test func backgroundBecomesMeta() {
        let p = ToolCallLabel.preview("Run vitest --watch (in the background)")
        #expect(p.target == "vitest --watch" && p.meta == "background")
    }

    @Test func pathsTruncateFromTheStart() {
        #expect(ToolCallLabel.preview("Read a.ts").targetIsPath)
        #expect(!ToolCallLabel.preview("Run ls").targetIsPath)
    }

    @Test func elapsedWords() {
        #expect(ElapsedFormat.short(8) == "8s")
        #expect(ElapsedFormat.short(72) == "1m 12s")
        #expect(ElapsedFormat.short(3720) == "1h 2m")
        #expect(ElapsedFormat.short(-4) == "0s")
        #expect(ElapsedFormat.thought(8) == "Thought for 8s")
        #expect(ElapsedFormat.thought(nil) == "Thought")
    }

    @Test func finishedTurnFoldsEverything() {
        let steps = [step("thinking", "plan", 0), step("tool", "Read a.ts", 8), step("tool", "Edit a.ts", 10), step("note", "done", 12)]
        let block = TurnFolding.block(steps: steps, working: false)
        #expect(block.shown.isEmpty)
        #expect(block.foldTitle == "Worked · 3 steps")
    }

    @Test func oneStepReadsSingular() {
        #expect(TurnFolding.block(steps: [step("tool", "Read a.ts")], working: false).foldTitle == "Worked · 1 step")
    }

    @Test func workingTurnListsNewestAndFoldsOlder() {
        let steps = (0..<9).map { step("tool", "Read f\($0).ts", Double($0)) }
        let block = TurnFolding.block(steps: steps, working: true, keepRecent: 6)
        #expect(block.shown.count == 6)
        #expect(block.foldTitle == "Worked · 3 steps")
    }

    @Test func lastToolIsRunningOnlyWhileWorking() {
        let steps = [step("tool", "Read a.ts", 0), step("tool", "Run npm test", 5)]
        let live = TurnFolding.block(steps: steps, working: true)
        guard case .tool(_, let p0, let r0, _) = live.shown[0], case .tool(_, _, let r1, _) = live.shown[1] else { Issue.record("shape"); return }
        #expect(!r0 && r1)
        #expect(p0.meta == "5s")
    }

    @Test func thinkingSecondsComeFromTheNextStep() {
        let block = TurnFolding.block(steps: [step("thinking", "hm", 0), step("tool", "Read a.ts", 8)], working: true)
        guard case .thinking(_, _, let seconds, let live) = block.shown[0] else { Issue.record("shape"); return }
        #expect(seconds == 8 && !live)
    }

    @Test func newestThinkingIsLiveWhileWorking() {
        let block = TurnFolding.block(steps: [step("thinking", "hm", 0)], working: true)
        guard case .thinking(_, _, _, let live) = block.shown[0] else { Issue.record("shape"); return }
        #expect(live)
    }

    @Test func youNotesAndBackgroundAreNotSteps() {
        let steps = [step("you", "hi"), step("note", "text"), step("background", "x finished"), step("tool", "Read a.ts")]
        #expect(TurnFolding.block(steps: steps, working: false).folded.count == 1)
    }

    @Test func turnStartIsYourNewestMessage() {
        let t = Date(timeIntervalSince1970: 500)
        let m = [ChatMessage(id: "1", role: .user, text: "a", at: t), ChatMessage(id: "2", role: .assistant, text: "b", at: t + 5)]
        #expect(TurnFolding.turnStart(messages: m, steps: []) == t)
        #expect(TurnFolding.turnStart(messages: [], steps: [step("tool", "x", 3)]) == Date(timeIntervalSince1970: 1_003))
    }

    @Test func diffParsesNumbersAndStats() {
        let d = "--- a/x\n+++ b/x\n@@ -88,3 +88,4 @@\n ctx\n-old\n+new1\n+new2\n"
        let lines = InlineDiff.parse(d)
        #expect(lines.map(\.kind) == [.hunk, .context, .removed, .added, .added])
        #expect(lines[1].number == 88 && lines[2].number == 89 && lines[3].number == 89 && lines[4].number == 90)
        #expect(InlineDiff.stat(lines) == (2, 1))
    }

    @Test func diffShowsFourteenLinesThenAll() {
        let lines = (0..<20).map { InlineDiffLine(kind: .added, number: $0, text: "l") }
        #expect(InlineDiff.visible(lines, showAll: false).lines.count == 14)
        #expect(InlineDiff.visible(lines, showAll: false).hidden == 6)
        #expect(InlineDiff.visible(lines, showAll: true).hidden == 0)
    }

    @Test func placeholdersFollowTheTable() {
        func p(_ phase: ComposerPhase, ro: String? = nil, off: Bool = false, host: Bool = false) -> String {
            ComposerPrompt.placeholder(agent: "Claude", workspace: "mallard", phase: phase, readOnlyReason: ro, offline: off, hostDown: host)
        }
        #expect(p(.idle) == "Tell Claude what to do next")
        #expect(p(.working) == "Add a follow-up. Claude reads it after this turn")
        #expect(p(.approval) == "Allow or deny above, or tell Claude what to do instead")
        #expect(p(.plan) == "Adjust the plan, or approve it above")
        #expect(p(.question) == "Answer above, or write your own answer")
        #expect(p(.working, host: true) == "Squeak's session host isn't running")
        #expect(p(.idle, ro: "no") == "Read-only: no")
        #expect(p(.idle, off: true).hasPrefix("Offline"))
        #expect(ComposerPrompt.placeholder(agent: "Codex", workspace: nil, phase: .idle) == "Message Codex")
    }

    @Test func roundButtonKinds() {
        #expect(ComposerPrompt.button(phase: .working, hasContent: false, canStop: true) == .stop)
        #expect(ComposerPrompt.button(phase: .working, hasContent: false, canStop: false) == .disabled)
        #expect(ComposerPrompt.button(phase: .working, hasContent: true, canStop: true) == .queue)
        #expect(ComposerPrompt.button(phase: .idle, hasContent: false, canStop: true) == .send)
    }

    @Test func hintsListOnlyLiveKeys() {
        let w = ComposerHints.keys(phase: .working, queueFirst: true, canStop: true)
        #expect(w.map(\.label) == ["queue", "steer now", "stop"])
        #expect(ComposerHints.keys(phase: .working, queueFirst: false, canStop: false).map(\.label) == ["steer", "queue"])
        #expect(ComposerHints.keys(phase: .idle, queueFirst: true, canStop: true).map(\.label) == ["send", "new line"])
    }

    @Test func contextLeftIsWhatRemains() {
        #expect(ContextLeft.text(used: 62) == "ctx 38% left")
        #expect(ContextLeft.text(used: nil) == nil)
        #expect(ContextLeft.text(used: 140) == "ctx 0% left")
    }

    @Test func modeChipOnlyForNativeWithAMode() {
        #expect(ComposerMode.chip(source: .conductor, mode: .plan) == nil)
        #expect(ComposerMode.chip(source: .squeak, mode: nil) == nil)
        #expect(ComposerMode.chip(source: .squeak, mode: .plan) == .plan)
        #expect(ComposerMode.skipApprovals.tone == .needsYou)
        #expect(ComposerMode.acceptEdits.word == "Accept edits")
    }

    @Test func questionKeysAreOneToNine() {
        let q = QuestionCardModel(question: "Which?", options: [.init(title: "a"), .init(title: "b")])
        #expect(q.optionIndex(forKey: "1") == 0)
        #expect(q.optionIndex(forKey: "2") == 1)
        #expect(q.optionIndex(forKey: "3") == nil)
        #expect(q.optionIndex(forKey: "0") == nil)
    }
}
