/// A native chat's status and the host's agent tool names, each in its current spelling and the old one. The host
/// renamed both; chats made before keep the old words in their history, and Conductor chats still use them, so
/// everything the app matches goes through here and reads both.
public enum NativeStatus {
    /// The status in its current spelling; anything else comes back unchanged.
    public static func normalized(_ raw: String) -> String {
        switch raw {
        case "needs_user_permission": "awaiting_approval"
        case "needs_plan_response": "awaiting_plan"
        case "needs_user_input": "awaiting_answer"
        case "cancelling": "stopping"
        default: raw
        }
    }

    /// The agent is waiting on the person: an approval, a plan or an answer.
    public static func isAwaitingPerson(_ raw: String) -> Bool {
        switch normalized(raw) {
        case "awaiting_approval", "awaiting_plan", "awaiting_answer": true
        default: false
        }
    }

    public static func isAwaitingApproval(_ raw: String) -> Bool { normalized(raw) == "awaiting_approval" }

    /// A turn is being stopped.
    public static func isStopping(_ raw: String) -> Bool { normalized(raw) == "stopping" }

    /// An agent tool in its current spelling (old names map to the new ones; others unchanged).
    public static func normalizedTool(_ raw: String) -> String {
        switch raw {
        case "workspace_diff": "stream_changes"
        case "review_comments": "list_review_notes"
        case "add_review_comment": "add_review_note"
        case "resolve_review_comment": "resolve_review_note"
        case "notify_user": "page_person"
        case "update_progress": "set_progress"
        case "set_target_branch": "set_merge_branch"
        case "terminal_output": "script_output"
        default: raw
        }
    }
}
