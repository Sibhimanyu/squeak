import Foundation
import Testing
@testable import SqueakMacCore

struct DucklingPanelTests {
    private let chip = Duckling(id: "t", title: "Scan", model: "Sonnet 5.5", status: .running, startedAt: Date(timeIntervalSince1970: 0))
    private static func step(_ text: String) -> DaemonActivity.Step {
        try! JSONDecoder().decode(DaemonActivity.Step.self, from: Data(#"{"kind":"tool","text":"\#(text)"}"#.utf8))
    }
    private func panel(_ d: DucklingDetail, chip: Duckling? = nil) -> DucklingPanelModel {
        DucklingPanelModel.make(result: .success(d), chip: chip ?? self.chip)
    }

    @Test func stepsFirstThenReportThenBrief() {
        let step = Self.step("Read a.swift")
        let p = panel(DucklingDetail(id: "t", status: "done", brief: "Do it", steps: [step], report: "All good"))
        #expect(p.parts == [.steps, .report, .brief])
        #expect(panel(DucklingDetail(id: "t", status: "running", brief: "Do it", steps: [step])).parts == [.steps, .brief])
        #expect(panel(DucklingDetail(id: "t", status: "running")).parts == [.steps])
        #expect(DucklingPanelModel.make(result: nil, chip: chip).parts == [.steps])
    }

    @Test func briefIsFoldedToThreeLines() {
        let long = "one\n\ntwo\nthree\nfour\nfive"
        let r = DucklingPanelModel.briefPreview(long)
        #expect(r.text == "one\ntwo\nthree" && r.isCut)
        #expect(DucklingPanelModel.briefPreview("short").isCut == false)
        let wide = DucklingPanelModel.briefPreview(String(repeating: "word ", count: 200))
        #expect(wide.isCut && wide.text.count <= DucklingPanelModel.briefCharLimit && !wide.text.hasSuffix(" "))
    }

    @Test func emptyStepsSaySoInsteadOfBlank() {
        #expect(panel(DucklingDetail(id: "t", status: "running")).stepsEmptyText == "Waiting for its first step…")
        #expect(panel(DucklingDetail(id: "t", status: "done")).stepsEmptyText == "No steps were recorded")
        let step = Self.step("Run ls")
        #expect(panel(DucklingDetail(id: "t", status: "done", steps: [step])).stepsEmptyText == nil)
        #expect(DucklingPanelModel.make(result: nil, chip: chip).stepsEmptyText == nil)
        #expect(panel(DucklingDetail(id: "t", status: "done")).message == nil)
    }

    // Shapes from a live chat: a background `Bash` whose detail carries the command's output tail and exit code.
    private static let shellJSON = #"""
    {"id":"toolu_sh","kind":"shell","title":"Wait up to 5 min for the appcast to show 1.9.1","status":"running",
     "brief":"for i in $(seq 1 30); do grep -q \"1.9.1)\" && break; done","steps":[],
     "output":{"text":"poll 1\npoll 2","truncated":true,"exists":true},"exitCode":null}
    """#

    @Test func aBackgroundCommandShowsOutputAndTheCommandNotSteps() throws {
        let d = try JSONDecoder().decode(DucklingDetail.self, from: Data(Self.shellJSON.utf8))
        let p = panel(d, chip: Duckling(id: "toolu_sh", kind: .shell, title: "Wait", status: .running))
        #expect(p.kind == .shell)
        #expect(p.parts == [.output, .command])
        #expect(p.stepsEmptyText == nil)
        #expect(p.output?.text == "poll 1\npoll 2" && p.outputEmptyText == nil)
        #expect(p.statusLine == "Running")
    }

    @Test func aCommandWithoutOutputSaysSoAndEndsWithItsExitCode() {
        let running = panel(DucklingDetail(id: "t", status: "running", brief: "sleep 9", kind: .shell, output: .init(exists: false)))
        #expect(running.outputEmptyText == "No output yet")
        let done = panel(DucklingDetail(id: "t", status: "done", brief: "ls", kind: .shell, exitCode: 0, output: .init(text: "a")))
        #expect(done.statusLine == "Exited with code 0" && done.outputEmptyText == nil)
        #expect(panel(DucklingDetail(id: "t", status: "failed", kind: .shell, exitCode: 2)).statusLine == "Exited with code 2")
        #expect(panel(DucklingDetail(id: "t", status: "stopped", kind: .shell)).statusLine == "Killed")
        #expect(panel(DucklingDetail(id: "t", status: "done", kind: .shell)).outputEmptyText == "No output")
        // before the route answers the chip's kind already picks the command view
        let early = DucklingPanelModel.make(result: nil, chip: Duckling(id: "t", kind: .shell, title: "x", status: .running))
        #expect(early.parts == [.output])
        // a subagent keeps its steps and its plain status word
        #expect(panel(DucklingDetail(id: "t", status: "done")).statusLine == "Finished")
    }

    @Test func oldHostsWithoutKindOrOutputStillDecode() throws {
        let d = try JSONDecoder().decode(DucklingDetail.self, from: Data(#"{"id":"t","status":"running","steps":[]}"#.utf8))
        #expect(d.kind == nil && d.output == nil && d.exitCode == nil)
        let c = try JSONDecoder().decode(Duckling.self, from: Data(#"{"id":"t","kind":"shell","title":"x","status":"done","exitCode":3}"#.utf8))
        #expect(c.kind == .shell && c.exitCode == 3)
    }

    @Test func elapsedUsesTheDetailsTimes() {
        let d = DucklingDetail(id: "t", status: "done", startedAt: Date(timeIntervalSince1970: 0), endedAt: Date(timeIntervalSince1970: 250))
        #expect(panel(d).elapsed() == "4m")
    }

    @Test func anotherChatClosesIt() {
        let a = SessionKey(provider: "squeak", hostSessionId: "a"), b = SessionKey(provider: "squeak", hostSessionId: "b")
        let ref = DucklingRef(session: a, taskId: "t")
        #expect(DucklingRef.open(ref, whenSelected: a) == ref)
        #expect(DucklingRef.open(ref, whenSelected: b) == nil)
        #expect(DucklingRef.open(ref, whenSelected: nil) == nil)
        #expect(DucklingRef.open(nil, whenSelected: a) == nil)
    }

    @Test func workingLineNamesTheAgentAndItsDucklings() {
        #expect(DucklingWords.workingLine("Working… · Opus 5.5", running: 2) == "Working… · Opus 5.5 · 2 ducklings working")
        #expect(DucklingWords.workingLine("Working…", running: 0) == "Working…")
    }
}
