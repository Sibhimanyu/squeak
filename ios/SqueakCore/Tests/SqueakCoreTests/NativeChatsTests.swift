import Foundation
import XCTest
@testable import SqueakCore

/// Pins the `native` command and the view fields to docs/remote-channel.md, "Squeak's own chats from the phone".
final class NativeChatsTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func channel() -> Channel {
        Channel(pairing: PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac"), deviceId: "phone-1", transport: FakeTransport())
    }

    private func open(_ doc: ChannelDocument) throws -> [String: Any] {
        let value = try ChannelCrypto.open(JSONValue.self, box: doc.box, key: key)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    func testRespondCarriesExactlyTheKeysTheMacReads() throws {
        let (_, doc) = try channel().nativeRespondDocument(
            sessionKey: "squeak-native:n1", requestId: "r1", decision: .allowForChat, signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        let json = try open(doc)
        XCTAssertEqual(Set(json.keys), ["v", "kind", "action", "sessionKey", "requestId", "decision", "scope", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"] as? String, "native")
        XCTAssertEqual(json["action"] as? String, "respond")
        XCTAssertEqual(json["decision"] as? String, "allow")
        XCTAssertEqual(json["scope"] as? String, "session")
    }

    func testAllowOnceHasNoScopeAndDenyCarriesItsNote() throws {
        let once = try open(try channel().nativeRespondDocument(
            sessionKey: "k", requestId: "r", decision: .allowOnce, signer: SoftwareSigner()).document)
        XCTAssertNil(once["scope"]); XCTAssertNil(once["message"])
        let deny = try open(try channel().nativeRespondDocument(
            sessionKey: "k", requestId: "r", decision: .deny(note: "  Keep planning.  "), signer: SoftwareSigner()).document)
        XCTAssertEqual(deny["decision"] as? String, "deny")
        XCTAssertEqual(deny["message"] as? String, "Keep planning.")
        let bare = try open(try channel().nativeRespondDocument(
            sessionKey: "k", requestId: "r", decision: .deny(note: "  "), signer: SoftwareSigner()).document)
        XCTAssertNil(bare["message"])
    }

    func testAnswerCarriesQuestionIndexAndLabel() throws {
        let json = try open(try channel().nativeRespondDocument(
            sessionKey: "k", requestId: "r", decision: .answer([.init(question: 1, picked: "Blue")]),
            signer: SoftwareSigner()).document)
        let picks = try XCTUnwrap(json["answers"] as? [[String: Any]])
        XCTAssertEqual(picks.count, 1)
        XCTAssertEqual(picks[0]["question"] as? Int, 1)
        XCTAssertEqual(picks[0]["picked"] as? String, "Blue")
        XCTAssertEqual(json["decision"] as? String, "allow")
    }

    func testStartCarriesExactlyTheKeysTheMacReads() throws {
        let start = NativeStart(projectId: "p1", where: .newWorkspace, workspaceId: "ignored", agent: .codex, model: "gpt-5.6",
                                effort: nil, permissionMode: "plan", text: "Add a timer")
        let json = try open(try channel().nativeStartDocument(start, signer: SoftwareSigner()).document)
        // A workspace id rides only with `where: workspace`; no effort is no key.
        XCTAssertEqual(Set(json.keys), ["v", "kind", "action", "projectId", "where", "agent", "model", "permissionMode", "text", "nonce", "expiresAt"])
        XCTAssertEqual(json["where"] as? String, "newWorkspace")
        XCTAssertEqual(json["agent"] as? String, "codex")
        let inWorkspace = try open(try channel().nativeStartDocument(
            NativeStart(projectId: "p1", where: .workspace, workspaceId: "w1", agent: .claude, model: "m", effort: "high",
                        permissionMode: "default", text: "x"), signer: SoftwareSigner()).document)
        XCTAssertEqual(inWorkspace["workspaceId"] as? String, "w1")
        XCTAssertEqual(inWorkspace["effort"] as? String, "high")
    }

    func testViewDecodesWithAndWithoutTheNativeFields() throws {
        let base = try JSONEncoder().encode(PhoneSnapshot(v: 1, mac: "m", generatedAt: "", duck: .init(blockedCount: 0, workingCount: 0), sessions: [], recent: []))
        var obj = try JSONSerialization.jsonObject(with: base) as! [String: Any]
        let without = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertNil(without.nativeProjects); XCTAssertNil(without.nativeModels)
        obj["nativeProjects"] = [["id": "p1", "name": "farm", "workspaces": [["id": "w1", "name": "arm", "branch": "arm"]]]]
        obj["nativePermissionModes"] = ["default", "plan"]
        let with = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertEqual(with.nativeProjects?.first?.workspaces.first?.branch, "arm")
        XCTAssertEqual(with.nativePermissionModes, ["default", "plan"])
    }

    func testNativeWords() {
        let tool = NativeRequest(id: "r", kind: "tool", summary: "Bash: ls", tool: "Bash", command: "ls", chatRule: true)
        XCTAssertEqual(NativeWords.heading(tool, agentName: "Claude"), "Claude wants to use Bash")
        XCTAssertEqual(NativeWords.target(tool), "ls")
        let plan = NativeRequest(id: "r", kind: "plan", summary: "s", plan: "Do it")
        XCTAssertEqual(NativeWords.heading(plan, agentName: "Codex"), "Codex's plan")
        XCTAssertNil(NativeWords.target(plan))
        XCTAssertEqual(NativeWords.modeLabel("acceptEdits"), "Accept edits")
    }
}
