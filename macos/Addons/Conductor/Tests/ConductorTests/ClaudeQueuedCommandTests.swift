import Foundation
import Testing
@testable import Conductor
@testable import SqueakMacCore

@Suite("Claude steps for messages queued mid-turn")
struct ClaudeQueuedCommandTests {
    func tool(_ id: String) -> [String: Any] {
        ["type": "assistant", "timestamp": "2026-09-26T03:00:00.000Z",
         "message": ["id": id, "content": [["type": "tool_use", "id": "t-\(id)", "name": "Bash", "input": ["description": "Step"]]]]]
    }
    func user(_ text: Any, at: String = "2026-09-26T02:59:00.000Z", uuid: String? = nil) -> [String: Any] {
        var e: [String: Any] = ["type": "user", "timestamp": at, "message": ["content": text]]
        if let uuid { e["uuid"] = uuid }
        return e
    }
    func attach(_ extra: [String: Any], uuid: String, at: String = "2026-09-26T03:00:05.000Z") -> [String: Any] {
        var a: [String: Any] = ["type": "queued_command", "prompt": "x"]
        for (k, v) in extra { a[k] = v }
        return ["type": "attachment", "uuid": uuid, "timestamp": at, "attachment": a]
    }
    func you(_ entries: [[String: Any]]) -> [String] { kinds(entries).filter { $0.hasPrefix("you:") } }
    func queued(_ prompt: String, mode: String = "prompt") -> [String: Any] {
        ["type": "attachment", "timestamp": "2026-09-26T03:00:05.000Z",
         "attachment": ["type": "queued_command", "prompt": prompt, "commandMode": mode]]
    }
    func kinds(_ entries: [[String: Any]]) -> [String] {
        ClaudeActivityReader.claudeSteps(entries).map { "\($0.kind):\($0.text)" }
    }

    @Test func queuedCommandIsAYouStepInPlace() {
        #expect(kinds([user("go"), tool("m1"), queued("also X"), tool("m2")]) == ["tool:Step", "you:also X", "tool:Step"])
    }

    @Test func notificationsAndOtherModesAreNotYou() {
        #expect(kinds([user("go"), tool("m1"),
                       queued("<task-notification><summary>x</summary></task-notification>", mode: "task-notification"),
                       queued("other", mode: "bash")]) == ["tool:Step"])
    }

    @Test func continuationRecapIsNotYouAndUserCopyDoesNotDuplicate() {
        let recap = user("This session is being continued from a previous conversation that ran out.")
        #expect(kinds([user("go"), tool("m1"), recap]) == ["tool:Step"])
        #expect(kinds([user("go"), tool("m1"), queued("also X"), user("also X", at: "2026-09-26T03:00:06.000Z")]) == ["tool:Step", "you:also X"])
    }

    var base: [[String: Any]] { [user("go"), tool("m1")] }

    @Test func messageWithFilesReadsAsTheTypedText() {
        let withFiles = "\n<system_instruction>\nFiles: .context/attachments/a1/image.png (17.8 KB)\n</system_instruction>\n\n\n\nlook at this one"
        #expect(you(base + [queued(withFiles)]) == ["you:look at this one"])
        #expect(you(base + [user(withFiles, at: "2026-09-26T03:00:05.000Z")]) == ["you:look at this one"])
        #expect(you(base + [user([["type": "text", "text": withFiles]], at: "2026-09-26T03:00:05.000Z")]) == ["you:look at this one"])
        let only = "\n<system_instruction>\nFiles\n</system_instruction>\n\n\n"
        #expect(you(base + [queued(only)]).isEmpty)
        #expect(you(base + [user(only, at: "2026-09-26T03:00:05.000Z")]).isEmpty)
        #expect(you(base + [queued("<system_instruction>never closed")]).isEmpty)
        #expect(ClaudeActivityReader.stripSystemInstruction("  plain <system_instruction>a</system_instruction> text ") == "plain <system_instruction>a</system_instruction> text")
    }

    @Test func identicalMessagesStayTwoSteps() {
        let e = base + [attach(["prompt": "again", "commandMode": "prompt"], uuid: "u1"), tool("m2"),
                        attach(["prompt": "again", "commandMode": "prompt"], uuid: "u2", at: "2026-09-26T03:00:40.000Z")]
        #expect(kinds(e) == ["tool:Step", "you:again", "tool:Step", "you:again"])
        let noUuid = base + [queued("again"), queued("again").merging(["timestamp": "2026-09-26T03:00:40.000Z"]) { $1 }]
        #expect(you(noUuid) == ["you:again", "you:again"])
    }

    @Test func oneMessageWrittenTwiceShowsOnce() {
        let q = attach(["prompt": "same", "commandMode": "prompt", "source_uuid": "src-1"], uuid: "u1")
        #expect(you(base + [q, user("same", at: "2026-09-26T03:00:06.500Z")]) == ["you:same"])
        #expect(you(base + [q, user("same", at: "2026-09-26T03:05:00.000Z", uuid: "src-1")]) == ["you:same"])
        #expect(you(base + [attach(["prompt": "same", "commandMode": "prompt"], uuid: "u1"),
                            user("same", at: "2026-09-26T03:01:06.000Z")]) == ["you:same", "you:same"])
    }

    @Test func systemNoticesAreNotYou() {
        let notices: [[String: Any]] = [
            ["commandMode": "prompt", "isMeta": true, "origin": ["kind": "coordinator"]],
            ["commandMode": "prompt", "isMeta": true],
            ["commandMode": "prompt", "origin": ["kind": "peer", "from": "uds:/tmp/cc-socks/1.sock"]],
            ["commandMode": "prompt", "origin": ["kind": "coordinator"]],
            ["commandMode": "prompt", "origin": ["kind": "task-notification", "producer": "agent"]],
            ["origin": ["kind": "coordinator"]],
            [:],
        ]
        for (i, n) in notices.enumerated() {
            var extra = n
            extra["prompt"] = "do this"
            #expect(you(base + [attach(extra, uuid: "n\(i)")]).isEmpty)
        }
        #expect(you(base + [attach(["prompt": "me", "commandMode": "prompt", "origin": ["kind": "human"]], uuid: "h")]) == ["you:me"])
        #expect(you(base + [attach(["prompt": "me", "commandMode": "prompt"], uuid: "h")]) == ["you:me"])
    }
}
