import Foundation
import Testing
@testable import SqueakMacCore

private func voice(_ json: String) -> VoiceSettings {
    try! JSONDecoder().decode(VoiceSettings.self, from: Data(json.utf8))
}

private func gateway(_ state: GatewayStatusState = .ok, version: String? = "0.11.0", latest: String? = "0.11.0", update: Bool = false) -> GatewayView {
    GatewayView(status: GatewayStatus(state: state, version: version), latestVersion: latest, updateAvailable: update)
}

/// Everything done: gateway ok and current, extension, PIN, realistic voice, an answered test.
private let readyVoice = #"""
{"mode":"gateway","callee":"101","pin":"set","policy":{"outgoing":"always","incoming":"always"},
 "natural":{"installed":true,"enabled":true,"voice":"af_heart"},
 "lastTest":{"at":1,"status":"answered","letter":"A"}}
"""#

private func facts(_ v: VoiceSettings?, gateway g: GatewayView? = gateway(), setup: NaturalSetupStatus? = nil,
                   reachable: Bool = true, outdated: Bool = false, placing: Bool = false) -> PhoneCallsFacts {
    PhoneCallsFacts(daemonReachable: reachable, voice: v, voiceOutdated: outdated, gateway: g, naturalSetup: setup, testPlacing: placing)
}

@Suite("Phone calls checklist") struct PhoneCallsChecklistTests {
    @Test func everythingDoneIsReady() {
        let c = PhoneCallsChecklist(facts(voice(readyVoice)))
        #expect(c.steps.map(\.id) == [.gateway, .addonUpdate, .extensionToRing, .pin, .realisticVoice, .testCall])
        #expect(c.steps.allSatisfy { $0.isDone })
        #expect(c.summary == .ready && c.summaryLine == "Phone calls are ready" && c.isReady)
    }

    @Test func noGatewayPairedBlocksTheRestAndCountsSteps() {
        let c = PhoneCallsChecklist(facts(voice(#"{"mode":"off","pin":"none","natural":{"installed":false,"enabled":true,"voice":"af_heart"}}"#), gateway: gateway(.none, version: nil, latest: nil)))
        #expect(c.step(.gateway)?.state == .todo && c.step(.gateway)?.action == .pairGateway)
        #expect(c.step(.addonUpdate)?.state == .blocked)
        #expect(c.step(.extensionToRing)?.state == .blocked)
        #expect(c.step(.pin)?.state == .blocked)
        #expect(c.step(.testCall)?.state == .blocked)
        // The optional realistic voice never counts: gateway, add-on, extension, PIN, test = 5.
        #expect(c.summary == .left(5) && c.summaryLine == "5 steps left")
    }

    @Test func staleGatewayAsksToPairAgainAndSipDownHasNoButton() {
        let stale = PhoneCallsChecklist(facts(voice(readyVoice), gateway: gateway(.stale)))
        #expect(stale.step(.gateway)?.state == .todo && stale.step(.gateway)?.action == .pairGateway)
        #expect(stale.step(.testCall)?.state == .blocked)
        let sip = PhoneCallsChecklist(facts(voice(readyVoice), gateway: GatewayView(status: GatewayStatus(state: .sipDown, sipError: "no route"))))
        #expect(sip.step(.gateway)?.action == nil)
        #expect(sip.step(.gateway)?.detail.contains("no route") == true)
    }

    @Test func anAddonUpdateIsOneStepLeftWithItsButton() {
        let c = PhoneCallsChecklist(facts(voice(readyVoice), gateway: gateway(latest: "0.12.0", update: true)))
        #expect(c.step(.addonUpdate)?.state == .todo && c.step(.addonUpdate)?.action == .updateAddon)
        #expect(c.step(.addonUpdate)?.detail == "Add-on 0.11.0 · 0.12.0 is available")
        #expect(c.summary == .left(1) && c.summaryLine == "1 step left")
    }

    @Test func missingExtensionTodoWithFocusAction() {
        let c = PhoneCallsChecklist(facts(voice(#"{"mode":"gateway","pin":"set","natural":{"installed":true,"enabled":true,"voice":"af_heart"}}"#)))
        #expect(c.step(.extensionToRing)?.state == .todo && c.step(.extensionToRing)?.action == .setExtension)
        #expect(c.step(.testCall)?.state == .blocked)
        // The daemon's default extension counts as set.
        let d = PhoneCallsChecklist(facts(voice(#"{"mode":"gateway","defaultCallee":"102","pin":"set"}"#)))
        #expect(d.step(.extensionToRing)?.state == .done && d.step(.extensionToRing)?.detail == "Squeak rings 102.")
    }

    @Test func pinSetOrConsciouslyOffIsDoneNoneIsTodo() {
        func pin(_ s: String) -> PhoneCallsStep? { PhoneCallsChecklist(facts(voice(#"{"mode":"gateway","callee":"101","pin":"\#(s)"}"#))).step(.pin) }
        #expect(pin("set")?.state == .done)
        #expect(pin("off")?.state == .done)
        #expect(pin("none")?.state == .todo && pin("none")?.action == .setPin)
        #expect(pin("unknown")?.state == .working)
        // An older daemon without PIN management has no PIN step at all.
        #expect(PhoneCallsChecklist(facts(voice(#"{"mode":"gateway","callee":"101"}"#))).step(.pin) == nil)
    }

    @Test func realisticVoiceStatesAreOptionalAndCarryTheirButton() {
        let missing = voice(#"{"mode":"gateway","callee":"101","pin":"set","natural":{"installed":false,"enabled":true,"voice":"af_heart"},"lastTest":{"at":1,"status":"answered"}}"#)
        let idle = PhoneCallsChecklist(facts(missing))
        #expect(idle.step(.realisticVoice)?.action == .installVoice && idle.step(.realisticVoice)?.isOptional == true)
        #expect(idle.isReady, "the realistic voice is optional")
        let running = PhoneCallsChecklist(facts(missing, setup: NaturalSetupStatus(state: .running, text: "Downloading the voice model: 100 of 326 MB", percent: 40)))
        #expect(running.step(.realisticVoice)?.state == .working)
        #expect(running.step(.realisticVoice)?.detail == "Downloading the voice model: 100 of 326 MB (40%)")
        #expect(running.step(.realisticVoice)?.action == nil)
        let failed = PhoneCallsChecklist(facts(missing, setup: NaturalSetupStatus(state: .failed, code: "no-network", error: "No internet.")))
        #expect(failed.step(.realisticVoice)?.action == .retryVoice && failed.step(.realisticVoice)?.detail == "No internet.")
        let python = PhoneCallsChecklist(facts(missing, setup: NaturalSetupStatus(state: .failed, code: "no-python", error: "Install Python (brew install python).")))
        #expect(python.step(.realisticVoice)?.action == nil, "Python must be installed first: a retry alone cannot help")
        #expect(python.step(.realisticVoice)?.detail.contains("brew install python") == true)
    }

    @Test func testCallStates() {
        func test(_ last: String, placing: Bool = false) -> PhoneCallsStep? {
            PhoneCallsChecklist(facts(voice(#"{"mode":"gateway","callee":"101","pin":"set",\#(last)}"#), placing: placing)).step(.testCall)
        }
        #expect(test(#""x":1"#)?.state == .todo && test(#""x":1"#)?.action == .testCall)
        #expect(test(#""lastTest":{"at":1,"status":"answered"}"#)?.state == .done)
        #expect(test(#""lastTest":{"at":1,"status":"unanswered"}"#)?.detail == "Nobody picked up.")
        #expect(test(#""lastTest":{"at":1,"status":"failed","reason":"busy"}"#)?.action == .testCall)
        #expect(test(#""lastTest":{"at":1,"status":"ringing"}"#)?.state == .working)
        #expect(test(#""x":1"#, placing: true)?.state == .working)
    }

    @Test func daemonDownClaimsNothing() {
        let c = PhoneCallsChecklist(facts(voice(readyVoice), reachable: false))
        #expect(c.summary == .unavailable && c.steps.count == 6)
        #expect(c.steps.allSatisfy { $0.state == .unknown && $0.action == nil })
        #expect(!c.isReady)
        let never = PhoneCallsChecklist(facts(nil))
        #expect(never.summary == .unavailable)
    }

    @Test func anOlderDaemonSaysToUpdate() {
        let c = PhoneCallsChecklist(facts(nil, outdated: true))
        #expect(c.summary == .outdated && c.steps.isEmpty)
    }

    @Test func directModeHasNoGatewaySteps() {
        let c = PhoneCallsChecklist(facts(voice(#"{"mode":"direct","callee":"101","pin":"set","lastTest":{"at":1,"status":"answered"}}"#), gateway: nil))
        #expect(c.step(.gateway) == nil && c.step(.addonUpdate) == nil)
        #expect(c.isReady)
    }
}

@Suite("Realistic voice install client") struct NaturalSetupTests {
    @Test func decodesEveryState() throws {
        func status(_ json: String) throws -> NaturalSetupStatus { try JSONDecoder().decode(NaturalSetupStatus.self, from: Data(json.utf8)) }
        let r = try status(#"{"state":"running","step":"model","text":"Downloading the voice model: 100 of 326 MB","percent":38,"bytes":100000000,"totalBytes":325532232}"#)
        #expect(r.isRunning && r.fraction == 0.38 && r.progressLine.hasSuffix("(38%)"))
        let f = try status(#"{"state":"failed","code":"no-python","error":"Needs Python."}"#)
        #expect(f.state == .failed && f.needsPython && f.failureLine == "Needs Python.")
        let ready = try status(#"{"state":"ready"}"#)
        let odd = try status(#"{"state":"surprise"}"#)
        #expect(ready.state == .ready && odd.state == .idle)
        #expect(NaturalSetupStatus(state: .failed).failureLine == "The voice could not be installed. Try again.")
    }

    private actor Canned: HTTPTransport {
        var seen: [HTTPRequest] = []
        let status: Int, body: String
        init(_ status: Int, _ body: String) { self.status = status; self.body = body }
        func send(_ request: HTTPRequest) async throws -> HTTPResponse {
            seen.append(request)
            return HTTPResponse(status: status, body: Data(body.utf8))
        }
        func requests() -> [HTTPRequest] { seen }
    }

    private func client(_ t: Canned) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" })
    }

    @Test func startPostsToTheDaemonWithTheTokenAndNothingElse() async throws {
        let t = Canned(200, #"{"state":"running","text":"Starting…","percent":0}"#)
        let outcome = try await client(t).startNaturalSetup()
        guard case let .started(s) = outcome else { Issue.record("not started"); return }
        #expect(s.isRunning)
        let req = await t.requests().first
        #expect(req?.method == "POST" && req?.url.path == "/control/voice/natural/setup")
        #expect(req?.headers["x-squeak-token"] == "tok" && req?.body == Data("{}".utf8))
    }

    @Test func refusalOutdatedAndStatus() async throws {
        let refused = try await client(Canned(400, #"{"error":"The realistic voice is already installed."}"#)).startNaturalSetup()
        #expect(refused == .refused("The realistic voice is already installed."))
        let old = try await client(Canned(404, "")).startNaturalSetup()
        #expect(old == .outdated)
        let none = try await client(Canned(404, "")).naturalSetupStatus()
        #expect(none == nil)
        let t = Canned(200, #"{"state":"ready"}"#)
        let ready = try await client(t).naturalSetupStatus()
        #expect(ready?.state == .ready)
        #expect(await t.requests().first?.method == "GET")
    }
}
