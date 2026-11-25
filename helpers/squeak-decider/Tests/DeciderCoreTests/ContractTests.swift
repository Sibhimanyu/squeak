import Foundation
import Testing

@testable import DeciderCore

struct FakeBackend: Backend {
    var vectors: [Double]? = nil
    var answer: Result<String, Unavailable> = .failure(Unavailable("off"))
    func embed(task: String, texts: [String]) -> [Double]? { vectors }
    func generate(system: String, prompt: String) async -> Result<String, Unavailable> { answer }
}

func run(_ json: String, _ backend: Backend) async -> [String: Any] {
    let out = await Handler.handle(Data(json.utf8), backend: backend).encoded()
    return (try? JSONSerialization.jsonObject(with: out) as? [String: Any]) ?? [:]
}

@Suite struct ContractTests {
    @Test func embedReturnsSimilaritiesInOrder() async {
        let r = await run(#"{"op":"embed","task":"fix the icon","texts":["a","b"]}"#, FakeBackend(vectors: [0.8, 0.1]))
        #expect(r["ok"] as? Bool == true)
        #expect(r["similarities"] as? [Double] == [0.8, 0.1])
    }

    @Test func embedWithNoTextsIsEmptyNotUnavailable() async {
        let r = await run(#"{"op":"embed","task":"x","texts":[]}"#, FakeBackend())
        #expect(r["ok"] as? Bool == true)
    }

    @Test func embedWithoutAnEmbeddingIsUnavailable() async {
        let r = await run(#"{"op":"embed","task":"x","texts":["y"]}"#, FakeBackend(vectors: nil))
        #expect(r["ok"] as? Bool == false)
        #expect(r["unavailable"] as? Bool == true)
    }

    @Test func writeReturnsTheModelsText() async {
        let r = await run(#"{"op":"write","system":"s","prompt":"p"}"#, FakeBackend(answer: .success("Zoom review fixes")))
        #expect(r["ok"] as? Bool == true)
        #expect(r["text"] as? String == "Zoom review fixes")
    }

    @Test func writeUnavailableWhenTheModelIsOff() async {
        let r = await run(#"{"op":"write","prompt":"p"}"#, FakeBackend())
        #expect(r["unavailable"] as? Bool == true)
    }

    @Test func decideUnavailableWhenTheModelIsOff() async {
        let r = await run(#"{"op":"decide","prompt":"p","allowed":["1","hatch"]}"#, FakeBackend())
        #expect(r["unavailable"] as? Bool == true)
        #expect(r["reason"] as? String == "off")
    }

    @Test func decideReturnsTheAllowedChoice() async {
        let b = FakeBackend(answer: .success(#"{"choice":"2"}"#))
        let r = await run(#"{"op":"decide","prompt":"p","allowed":["1","2","hatch","wait"]}"#, b)
        #expect(r["ok"] as? Bool == true)
        #expect(r["choice"] as? String == "2")
    }

    @Test func decideWithAnUnofferedAnswerIsNullChoice() async {
        let b = FakeBackend(answer: .success("I think 3 is best"))
        let r = await run(#"{"op":"decide","prompt":"p","allowed":["1","2","hatch"]}"#, b)
        #expect(r["ok"] as? Bool == true)
        #expect(r["choice"] is NSNull)
    }

    @Test func pickIsStrict() {
        #expect(Handler.pick("hatch or 1", allowed: ["1", "hatch"]) == nil)
        #expect(Handler.pick("Hatch.", allowed: ["1", "hatch"]) == "hatch")
    }

    @Test func badRequestsAreInvalidNotUnavailable() async {
        for json in ["nope", #"{"op":"fly"}"#, #"{"op":"decide","prompt":"p","allowed":[]}"#, #"{"op":"embed"}"#] {
            let r = await run(json, FakeBackend())
            #expect(r["ok"] as? Bool == false)
            #expect(r["unavailable"] as? Bool == false)
        }
    }

    @Test func scaleMapsCosineOntoTheBands() {
        #expect(AppleBackend.scale(0.3) == 0)
        #expect(abs(AppleBackend.scale(0.7) - 0.5) < 1e-9)
        #expect(AppleBackend.scale(0.99) == 1)
    }

    @Test func realEmbeddingRanksRelatedTextAbove() {
        guard let sims = AppleBackend().embed(
            task: "fix the toolbar icon alignment",
            texts: ["adjust the toolbar icon spacing", "set up the postgres database backup"]) else { return }
        #expect(sims[0] > sims[1])
    }

    @Test func realModelIsEitherAnAnswerOrUnavailable() async {
        let r = await AppleBackend().generate(system: "Reply with one word.", prompt: "Say hatch")
        if case .failure(let u) = r { #expect(!u.reason.isEmpty) }
    }
}
