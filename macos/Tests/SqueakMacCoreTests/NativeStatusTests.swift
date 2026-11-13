import Testing
@testable import SqueakMacCore

@Suite struct NativeStatusTests {
    static let pairs = [("needs_user_permission", "awaiting_approval"), ("needs_plan_response", "awaiting_plan"),
                        ("needs_user_input", "awaiting_answer"), ("cancelling", "stopping")]

    @Test func statusesNormalise() {
        for (old, new) in Self.pairs {
            #expect(NativeStatus.normalized(old) == new)
            #expect(NativeStatus.normalized(new) == new)
        }
        #expect(NativeStatus.normalized("working") == "working")
    }

    @Test func oldAndNewStatusesBehaveTheSame() {
        for (old, new) in Self.pairs {
            #expect(NativeAdapter.state(for: old, lastTurnEndedAt: nil) == NativeAdapter.state(for: new, lastTurnEndedAt: nil))
            #expect(PondThreadState(raw: old) == PondThreadState(raw: new))
            #expect(NativeLiveState.needsRequestRefetch(status: old, hasCard: false) == NativeLiveState.needsRequestRefetch(status: new, hasCard: false))
            #expect(DaemonInstaller.hostIsBusy(.sessions(statuses: [old])) && DaemonInstaller.hostIsBusy(.sessions(statuses: [new])))
        }
        #expect(NativeStatus.isAwaitingApproval("awaiting_approval") && NativeStatus.isAwaitingApproval("needs_user_permission"))
        #expect(!NativeStatus.isAwaitingApproval("awaiting_plan"))
    }

    @Test func toolsNormalise() {
        let pairs = [("workspace_diff", "stream_changes"), ("review_comments", "list_review_notes"),
                     ("add_review_comment", "add_review_note"), ("resolve_review_comment", "resolve_review_note"),
                     ("notify_user", "page_person"), ("update_progress", "set_progress"),
                     ("set_target_branch", "set_merge_branch"), ("terminal_output", "script_output")]
        for (old, new) in pairs {
            #expect(NativeStatus.normalizedTool(old) == new)
            #expect(NativeStatus.normalizedTool(new) == new)
        }
        for (old, new) in [("workspace_diff", "stream_changes"), ("review_comments", "list_review_notes"), ("terminal_output", "script_output")] {
            #expect(NativeTranscript.mcpLabel(server: "squeak", tool: old) == NativeTranscript.mcpLabel(server: "squeak", tool: new))
        }
    }
}
