import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Claude steps for messages queued mid-turn")
struct ClaudeQueuedCommandTests {
    func tool(_ id: String) -> [String: Any] {
        ["type": "assistant", "timestamp": "2026-09-26T03:00:00.000Z",
         "message": ["id": id, "content": [["type": "tool_use", "id": "t-\(id)", "name": "Bash", "input": ["description": "Step"]]]]]
    }
    func user(_ text: String) -> [String: Any] {
        ["type": "user", "timestamp": "2026-09-26T02:59:00.000Z", "message": ["content": text]]
    }
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
        #expect(kinds([user("go"), tool("m1"), queued("also X"), user("also X")]) == ["tool:Step", "you:also X"])
    }
}
