import Foundation
import Testing
@testable import SqueakMacCore

private let askJSON = """
{"toolUseId":"toolu_1","kind":"question","plan":null,"delivery":"stop-and-send","questions":[
 {"question":"Where?","header":"Where","multiSelect":true,"options":[{"label":"Menu bar","description":"Quick"},{"label":"iPhone app","description":null}]},
 {"question":"Battery too?","header":null,"multiSelect":false,"options":[{"label":"Yes","description":null},{"label":"No","description":null}]}]}
"""

private func client(_ t: FakeTransport, token: String? = "tok") -> DaemonClient {
    DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { token })
}

@Suite("Answering questions")
struct AnswerTests {
    @Test func readsThePendingAsk() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/session/s1/question", askJSON)
        let ask = try #require(try await client(t).pendingAsk(conductorSessionId: "s1"))
        #expect(ask.toolUseId == "toolu_1" && ask.kind == .question && ask.questions.count == 2)
        #expect(ask.questions[0].multiSelect && ask.questions[0].options[0].description == "Quick")
        #expect(ask.delivery == .stopAndSend)
        #expect(ask.routeNote == "Squeak will stop the question and send your answer as a message.")
        #expect(try await client(t).pendingAsk(conductorSessionId: "none") == nil) // 404
        await t.json("GET", "/control/session/s2/question", "null")
        #expect(try await client(t).pendingAsk(conductorSessionId: "s2") == nil)
    }

    @Test func formRules() throws {
        let ask = try JSONDecoder().decode(PendingAsk.self, from: Data(askJSON.utf8))
        var form = AskForm(ask)
        #expect(!form.isComplete && form.progress == "1 of 2" && form.summary == nil)
        form.toggle("Menu bar", in: 0); form.toggle("iPhone app", in: 0)
        #expect(form.isAnswered(0) && !form.isComplete)
        form.toggle("iPhone app", in: 0)
        #expect(form.picks[0] == ["Menu bar"])
        form.toggle("Yes", in: 1); form.toggle("No", in: 1) // single-select replaces
        #expect(form.picks[1] == ["No"] && form.isComplete)
        form.setUsingOther(true, in: 1)
        #expect(form.picks[1].isEmpty && !form.isAnswered(1)) // "something else" needs words
        form.setOther("  Later  ", in: 1)
        #expect(form.isComplete && form.summary == "Menu bar · Later")
        form.setUsingOther(true, in: 0); form.setOther("Dock", in: 0)
        #expect(form.answers() == [AskAnswer(question: 0, picked: ["Menu bar"], other: "Dock"), AskAnswer(question: 1, picked: [], other: "Later")])
        form.toggle("Nope", in: 0)
        #expect(!form.picks[0].contains("Nope"))
        form.setOther(String(repeating: "x", count: 3000), in: 0)
        #expect(form.other[0].count == AskForm.maxOther)
        form.next()
        #expect(form.index == 1 && !form.canGoNext && form.canGoBack)
    }

    @Test func planForm() {
        var form = AskForm(PendingAsk(toolUseId: "p", kind: .plan, plan: "1. Do it"))
        #expect(form.isComplete && form.plan == .approve)
        form.revising = true
        #expect(!form.isComplete)
        form.planNote = "Use SQLite"
        #expect(form.isComplete && form.plan == .revise(note: "Use SQLite"))
    }

    @Test func answerSendsExactBodyAndReadsTheResult() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/session/s1/answer", #"{"status":"answered","via":"stopped-and-sent","note":"Sent as a message after stopping the question."}"#)
        let r = await client(t).answer(
            conductorSessionId: "s1", toolUseId: "toolu_1", answers: [AskAnswer(question: 0, picked: ["A"], other: nil)])
        #expect(r == .answered(via: "stopped-and-sent", note: "Sent as a message after stopping the question."))
        let req = try #require(await t.requests.first)
        #expect(req.headers["x-squeak-token"] == "tok")
        let body = try #require(try JSONSerialization.jsonObject(with: req.body ?? Data()) as? [String: Any])
        #expect(Set(body.keys) == ["toolUseId", "answers"])
        #expect((body["answers"] as? [[String: Any]])?.first?["picked"] as? [String] == ["A"])
        await t.json("POST", "/control/session/s3/answer", #"{"status":"answered","via":"conductor"}"#)
        let p = await client(t).answer(conductorSessionId: "s3", toolUseId: "p", plan: .revise(note: "n"))
        #expect(p == .answered(via: "conductor", note: nil))
        let planReq = try #require(await t.requests.last)
        let planBody = try #require(try JSONSerialization.jsonObject(with: planReq.body ?? Data()) as? [String: Any])
        #expect((planBody["plan"] as? [String: Any])?["approve"] as? Bool == false)
    }

    @Test func answerMapsFailuresHonestly() async {
        let t = FakeTransport()
        await t.json("POST", "/control/session/a/answer", #"{"status":"refused","reason":"That question has moved on."}"#)
        #expect(await client(t).answer(conductorSessionId: "a", toolUseId: "x") == .refused(reason: "That question has moved on."))
        await t.json("POST", "/control/session/b/answer", #"{"status":"refused","reason":"Not confirmed — check Conductor (timed out)"}"#)
        if case .uncertain = await client(t).answer(conductorSessionId: "b", toolUseId: "x") {} else { Issue.record("expected uncertain") }
        #expect(await client(t).answer(conductorSessionId: "none", toolUseId: "x") == .refused(reason: "This version of the Squeak service can't take answers yet. Update the service."))
        #expect(await client(t, token: nil).answer(conductorSessionId: "a", toolUseId: "x") == .refused(reason: "Squeak's access token was not found"))
        #expect(AnswerOutcome.answered(via: "conductor", note: "Not confirmed — check Conductor").line == "Not confirmed — check Conductor")
        #expect(AnswerOutcome.answered(via: "conductor", note: nil).line == "Answered in Conductor.")
    }
}
