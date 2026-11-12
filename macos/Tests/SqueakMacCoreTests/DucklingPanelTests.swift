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
        #expect(panel(DucklingDetail(id: "t", status: "running")).stepsEmptyText == "Steps will appear here as it works")
        #expect(panel(DucklingDetail(id: "t", status: "done")).stepsEmptyText == "No steps were recorded")
        let step = Self.step("Run ls")
        #expect(panel(DucklingDetail(id: "t", status: "done", steps: [step])).stepsEmptyText == nil)
        #expect(DucklingPanelModel.make(result: nil, chip: chip).stepsEmptyText == nil)
        #expect(panel(DucklingDetail(id: "t", status: "done")).message == nil)
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
        #expect(DucklingWords.workingLine("Working… · Opus 5.5", running: 2) == "Working… · Opus 5.5 · 2 ducklings in the background")
        #expect(DucklingWords.workingLine("Working…", running: 0) == "Working…")
    }
}
