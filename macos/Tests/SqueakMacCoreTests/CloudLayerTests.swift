import Foundation
import Testing
@testable import SqueakMacCore

private final class CloudStub: HTTPTransport, @unchecked Sendable {
    let status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int, body: String) { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

@Suite("Cloud layer")
struct CloudLayerTests {
    private func client(_ t: CloudStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }

    static let full = #"""
    {"active":"firebase",
     "firebase":{"configured":true,"projectId":"squeak-1","databaseUrl":"https://squeak-1.firebasedatabase.app",
       "lastTest":{"at":1,"ok":true,"writeMs":136,"readMs":135,"noticeMs":142}},
     "catalyst":{"configured":false,"cli":{"installed":true,"version":"1.29.1","loggedIn":true,"org":"o"},
       "projectId":null,"projectName":null,"dc":"in","appUrl":null,
       "steps":[{"id":"cli","state":"done"},{"id":"project","state":"todo","consoleUrl":"https://console.catalyst.zoho.in"},
                {"id":"table","state":"todo"},{"id":"deploy","state":"working","detail":"Deploying"},
                {"id":"channel","state":"todo"},{"id":"verify","state":"error"}],
       "lastTest":null}}
    """#

    // MARK: Decoding

    @Test func decodesTheContractExample() throws {
        let s = try JSONDecoder().decode(CloudState.self, from: Data(Self.full.utf8))
        #expect(s.active == "firebase")
        #expect(s.firebase?.projectId == "squeak-1")
        #expect(s.firebase?.lastTest == CloudTest(at: 1, ok: true, writeMs: 136, readMs: 135, noticeMs: 142))
        #expect(s.catalyst?.cli?.version == "1.29.1")
        #expect(s.catalyst?.steps.map(\.id) == ["cli", "project", "table", "deploy", "channel", "verify"])
        #expect(s.catalyst?.steps.map(\.state) == [.done, .todo, .todo, .working, .todo, .error])
        #expect(s.catalyst?.steps[1].consoleURL?.host == "console.catalyst.zoho.in")
        #expect(s.catalystBusy)
        #expect(s.status(.firebase) == .inUse)
        #expect(s.status(.catalyst) == .notSetUp)
        #expect(s.comparison == nil)  // Catalyst has no test yet
    }

    @Test func missingBlocksAreNilAndTheCardsHide() throws {
        let s = try JSONDecoder().decode(CloudState.self, from: Data(#"{"active":"firebase","firebase":{"configured":true}}"#.utf8))
        #expect(s.catalyst == nil)
        #expect(s.firebase?.lastTest == nil)
        let empty = try JSONDecoder().decode(CloudState.self, from: Data("{}".utf8))
        #expect(empty.firebase == nil && empty.catalyst == nil && empty.active == nil)
        #expect(empty.status(.catalyst) == .notSetUp)
    }

    @Test func unknownStepsAndStatesAreKeptGenerically() throws {
        let body = #"{"catalyst":{"configured":true,"steps":[{"id":"billing","state":"paused","detail":"Hold on"},{"state":"done"},{"id":"cli","state":"done"}]}}"#
        let s = try JSONDecoder().decode(CloudState.self, from: Data(body.utf8))
        // The id-less step is dropped; the unknown one stays, with its own state.
        #expect(s.catalyst?.steps.map(\.id) == ["billing", "cli"])
        #expect(s.catalyst?.steps[0].state == .unknown("paused"))
        let p = CloudStepPresentation.make(step: s.catalyst!.steps[0], cli: nil)
        #expect(p.title == "billing" && p.action == .none && p.instruction == "Hold on")
        #expect(s.status(.catalyst) == .ready)
    }

    @Test func aNonHttpsConsoleLinkIsNeverOpened() {
        #expect(CloudStep(id: "x", state: .todo, consoleUrl: "file:///etc/passwd").consoleURL == nil)
        #expect(CloudStep(id: "x", state: .todo, consoleUrl: "javascript:alert(1)").consoleURL == nil)
    }

    @Test func comparisonNeedsBothTests() throws {
        let body = #"{"active":"catalyst","firebase":{"configured":true,"lastTest":{"ok":true,"writeMs":100,"readMs":90,"noticeMs":120}},"catalyst":{"configured":true,"lastTest":{"ok":true,"writeMs":300.4,"readMs":250,"noticeMs":null}}}"#
        let s = try JSONDecoder().decode(CloudState.self, from: Data(body.utf8))
        #expect(s.comparison?.map(\.label) == ["Write", "Read", "Change notice"])
        #expect(s.comparison?[0].catalystMs == 300)
        #expect(CloudComparisonRow.format(s.comparison?[2].catalystMs) == "-")
        #expect(CloudComparisonRow.format(120) == "120 ms")
        #expect(s.status(.catalyst) == .inUse && s.status(.firebase) == .ready)
    }

    // MARK: Step actions

    private func step(_ id: String, _ state: CloudStepState = .todo) -> CloudStep { CloudStep(id: id, state: state) }

    @Test func cliStepInstallsThenSignsIn() {
        let missing = CloudStepPresentation.make(step: step("cli"), cli: CloudCLI(installed: false, loggedIn: false))
        #expect(missing.action == .install(command: "npm i -g zcatalyst-cli"))
        let signedOut = CloudStepPresentation.make(step: step("cli"), cli: CloudCLI(installed: true, loggedIn: false))
        #expect(signedOut.action == .signIn(command: "catalyst login"))
        let done = CloudStepPresentation.make(step: step("cli", .done), cli: CloudCLI(installed: true, version: "1.29.1", loggedIn: true))
        #expect(done.action == .none && done.instruction.contains("1.29.1"))
    }

    @Test func consoleStepsCarryTheExactFields() {
        let table = CloudStepPresentation.make(step: step("table"), cli: nil)
        #expect(table.action == .openConsole)
        #expect(table.fields.map(\.value) == ["squeak_docs", "pk", "doc", "String"])
        let channel = CloudStepPresentation.make(step: step("channel"), cli: nil)
        #expect(channel.fields.map(\.value) == ["squeak_notice", "Custom Logic", "squeak_relay"])
        #expect(CloudStepPresentation.make(step: step("project"), cli: nil).action == .chooseProject)
        #expect(CloudStepPresentation.make(step: step("project", .done), cli: nil).action == .none)
        #expect(CloudStepPresentation.make(step: step("deploy"), cli: nil).action == .deploy)
        #expect(CloudStepPresentation.make(step: step("verify"), cli: nil).action == .test)
    }

    @Test func consoleUrlFollowsTheDataCentre() {
        #expect(CloudConsole.url(dc: "in").absoluteString == "https://console.catalyst.zoho.in")
        #expect(CloudConsole.url(dc: "us").absoluteString == "https://console.catalyst.zoho.com")
        #expect(CloudConsole.url(dc: "au").absoluteString == "https://console.catalyst.zoho.com.au")
        #expect(CloudConsole.url(dc: nil).absoluteString == "https://console.catalyst.zoho.in")
    }

    // MARK: Requests

    @Test func readsStateWithTheTokenAndMapsAnOlderDaemonToNil() async throws {
        let ok = CloudStub(status: 200, body: Self.full)
        let s = try await client(ok).cloudState()
        #expect(s?.active == "firebase")
        #expect(ok.requests[0].method == "GET" && ok.requests[0].url.path == "/control/cloud")
        #expect(ok.requests[0].headers["x-squeak-token"] == "tok")
        #expect(try await client(CloudStub(status: 404, body: "")).cloudState() == nil)
        await #expect(throws: (any Error).self) { _ = try await client(CloudStub(status: 401, body: "")).cloudState() }
    }

    @Test func projectsDecodeAndSkipUnreadableOnes() async throws {
        let t = CloudStub(status: 200, body: #"{"projects":[{"id":"123","name":"squeak"},{"id":456,"name":"b"},{"name":"no id"}]}"#)
        let p = try await client(t).catalystProjects()
        #expect(p == [CloudProject(id: "123", name: "squeak"), CloudProject(id: "456", name: "b")])
        #expect(t.requests[0].url.path == "/control/cloud/catalyst/projects")
        #expect(try await client(CloudStub(status: 404, body: "")).catalystProjects() == nil)
    }

    private func body(_ t: CloudStub) -> [String: String] {
        (try? JSONSerialization.jsonObject(with: t.requests.last?.body ?? Data())) as? [String: String] ?? [:]
    }

    @Test func everyWriteRouteSendsItsExactBody() async {
        let t = CloudStub(status: 200, body: #"{"ok":true}"#)
        let c = client(t)
        _ = await c.selectCatalystProject(id: "123")
        #expect(t.requests.last?.method == "POST" && t.requests.last?.url.path == "/control/cloud/catalyst/project")
        #expect(body(t) == ["projectId": "123"])
        _ = await c.deployCatalyst()
        #expect(t.requests.last?.url.path == "/control/cloud/catalyst/deploy" && body(t) == [:])
        _ = await c.checkCatalyst()
        #expect(t.requests.last?.url.path == "/control/cloud/catalyst/check" && body(t) == [:])
        _ = await c.renameFirebase(displayName: "My Squeak")
        #expect(t.requests.last?.url.path == "/control/cloud/firebase/rename" && body(t) == ["displayName": "My Squeak"])
        _ = await c.selectCloud(.catalyst)
        #expect(t.requests.last?.url.path == "/control/cloud/select" && body(t) == ["provider": "catalyst"])
        _ = await c.testCloud(.firebase)
        #expect(t.requests.last?.url.path == "/control/cloud/test" && body(t) == ["provider": "firebase"])
        #expect(t.requests.allSatisfy { $0.headers["x-squeak-token"] == "tok" && $0.headers["content-type"] == "application/json" })
    }

    @Test func resultsMapToFixedAnswers() async {
        let moved = CloudStub(status: 200, body: #"{"ok":true,"moved":true}"#)
        #expect(await client(moved).selectCloud(.catalyst) == CloudAck(ok: true, moved: true, error: nil))
        let refused = CloudStub(status: 200, body: #"{"ok":false,"moved":false,"error":"Catalyst isn't ready."}"#)
        #expect(await client(refused).selectCloud(.catalyst) == CloudAck(ok: false, moved: false, error: "Catalyst isn't ready."))
        #expect(await client(CloudStub(status: 404, body: "")).selectCloud(.catalyst) == .olderDaemon)
        let bad = await client(CloudStub(status: 401, body: "")).renameFirebase(displayName: "x")
        #expect(!bad.ok && bad.error?.contains("token") == true)

        let test = await client(CloudStub(status: 200, body: #"{"ok":true,"writeMs":10,"readMs":11,"noticeMs":12}"#)).testCloud(.catalyst)
        #expect(test == CloudTest(ok: true, writeMs: 10, readMs: 11, noticeMs: 12))
        let failed = await client(CloudStub(status: 200, body: #"{"ok":false,"error":"No relay."}"#)).testCloud(.catalyst)
        #expect(!failed.ok && failed.error == "No relay.")
        let old = await client(CloudStub(status: 404, body: "")).testCloud(.firebase)
        #expect(!old.ok && old.error == CloudAck.olderDaemon.error)
    }

    @Test func noTokenSendsNothing() async {
        let t = CloudStub(status: 200, body: #"{"ok":true}"#)
        let c = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { nil })
        let a = await c.selectCloud(.firebase)
        #expect(!a.ok && t.requests.isEmpty)
    }

    @Test func cloudIsAnOrdinarySettingsSection() {
        #expect(SettingsSection(link: "cloud") == .cloud)
        #expect(SettingsSection.cloud.title == "Cloud")
    }
}
