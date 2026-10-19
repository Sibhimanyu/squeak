import Foundation

/// A Conductor chat with the workspace and repo context the fleet needs
/// (port of `FleetRegistrySessionRef`). Timestamps are normalized ISO strings.
public struct ConductorSessionRow: Hashable, Sendable {
    public var id: String
    public var workspaceId: String
    public var status: String?
    public var agentType: String?
    public var title: String?
    public var claudeSessionId: String?
    public var updatedAt: String
    public var lastUserMessageAt: String?
    public var contextUsedPercent: Double?
    public var directoryName: String?
    public var branch: String?
    public var derivedStatus: String?
    public var manualStatus: String?
    public var workspaceState: String?
    public var workspacePath: String?
    public var defaultBranch: String?
    public var repositoryName: String?
    /// When the latest turn ended, from the `result`/`error` row the agent writes.
    public var lastTurnEndedAt: String?
    public var lastTurnOutcome: TurnOutcome?
    /// The chat was closed in Conductor, or its repo hidden.
    public var isHidden: Bool
    /// What the agent is waiting to be told, when its newest unanswered tool
    /// call is a question tool. Conductor's own `status` stays `working` while
    /// its question modal is open.
    public var pendingQuestion: String?

    public enum TurnOutcome: String, Hashable, Sendable { case success, failed, aborted }

    public init(
        id: String, workspaceId: String, status: String? = nil, agentType: String? = nil, title: String? = nil,
        claudeSessionId: String? = nil, updatedAt: String, lastUserMessageAt: String? = nil,
        contextUsedPercent: Double? = nil, directoryName: String? = nil, branch: String? = nil,
        derivedStatus: String? = nil, manualStatus: String? = nil, workspaceState: String? = nil,
        workspacePath: String? = nil, defaultBranch: String? = nil, repositoryName: String? = nil,
        lastTurnEndedAt: String? = nil, lastTurnOutcome: TurnOutcome? = nil, isHidden: Bool = false,
        pendingQuestion: String? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.status = status
        self.agentType = agentType
        self.title = title
        self.claudeSessionId = claudeSessionId
        self.updatedAt = updatedAt
        self.lastUserMessageAt = lastUserMessageAt
        self.contextUsedPercent = contextUsedPercent
        self.directoryName = directoryName
        self.branch = branch
        self.derivedStatus = derivedStatus
        self.manualStatus = manualStatus
        self.workspaceState = workspaceState
        self.workspacePath = workspacePath
        self.defaultBranch = defaultBranch
        self.repositoryName = repositoryName
        self.lastTurnEndedAt = lastTurnEndedAt
        self.lastTurnOutcome = lastTurnOutcome
        self.isHidden = isHidden
        self.pendingQuestion = pendingQuestion
    }
}

/// One `session_messages` row.
public struct SessionMessageRecord: Hashable, Sendable {
    public var id: String?
    public var role: String
    public var content: String
    public var sentAt: String?
    public var turnId: String?
    public var model: String?

    public init(id: String? = nil, role: String, content: String, sentAt: String? = nil, turnId: String? = nil, model: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.sentAt = sentAt
        self.turnId = turnId
        self.model = model
    }
}

/// Reads against `conductor.db` (port of the read side of `conductor-registry.ts`).
public struct ConductorRegistry: Sendable {
    public let database: ConductorDatabase

    public init(database: ConductorDatabase = ConductorDatabase()) {
        self.database = database
    }

    /// Every session across every repo, newest first. Closed chats are returned
    /// flagged `isHidden`, not left out.
    public func listFleetSessions(limit: Int) throws -> [ConductorSessionRow] {
        let sql = """
            SELECT
              s.id,
              s.workspace_id as workspaceId,
              s.status,
              s.agent_type as agentType,
              s.title,
              s.claude_session_id as claudeSessionId,
              s.updated_at as updatedAt,
              s.last_user_message_at as lastUserMessageAt,
              s.context_used_percent as contextUsedPercent,
              w.directory_name as directoryName,
              w.branch as branch,
              w.derived_status as derivedStatus,
              w.manual_status as manualStatus,
              w.state as workspaceState,
              w.workspace_path as workspacePath,
              r.default_branch as defaultBranch,
              r.name as repositoryName,
              (
                SELECT m.sent_at || '|' || CASE
                  WHEN m.content LIKE '{"type":"error","content":"aborted by user"%' THEN 'aborted'
                  WHEN m.content LIKE '{"type":"error"%' THEN 'failed'
                  WHEN json_valid(m.content) AND json_extract(m.content, '$.is_error') = 1 THEN 'failed'
                  ELSE 'success'
                END
                FROM session_messages m
                WHERE m.session_id = s.id
                  AND m.role = 'assistant'
                  AND (m.content LIKE '{"type":"result"%' OR m.content LIKE '{"type":"error"%')
                ORDER BY m.rowid DESC
                LIMIT 1
              ) as lastTurnEnd,
              (IFNULL(s.is_hidden, 0) != 0 OR IFNULL(r.hidden, 0) != 0) as hidden
            FROM sessions s
            JOIN workspaces w ON w.id = s.workspace_id
            JOIN repos r ON r.id = w.repository_id
            ORDER BY datetime(s.updated_at) DESC
            LIMIT ?
            """
        return try database.query(sql, [.int(Int64(limit))]).compactMap { row in
            guard let id = row["id"]?.string, let workspaceId = row["workspaceId"]?.string else { return nil }
            var endedAt: String?
            var outcome: ConductorSessionRow.TurnOutcome?
            if let end = row["lastTurnEnd"]?.string {
                // `sent_at|outcome`; the timestamp has no '|' in either spelling.
                let parts = end.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2 {
                    endedAt = parts[0].isEmpty ? nil : ConductorTime.toIso(String(parts[0]))
                    outcome = ConductorSessionRow.TurnOutcome(rawValue: String(parts[1]))
                }
            }
            let updated = row["updatedAt"]?.string
            let hidden = row["hidden"]?.int == 1
            let status = row["status"]?.string
            let pending: String? =
                !hidden && ["working", "waiting", "needs_user_input"].contains(status ?? "")
                ? pendingQuestion(sessionId: id) : nil
            return ConductorSessionRow(
                id: id, workspaceId: workspaceId, status: row["status"]?.string,
                agentType: row["agentType"]?.string, title: row["title"]?.string,
                claudeSessionId: row["claudeSessionId"]?.string,
                updatedAt: ConductorTime.toIso(updated) ?? updated ?? "",
                lastUserMessageAt: ConductorTime.toIso(row["lastUserMessageAt"]?.string),
                contextUsedPercent: row["contextUsedPercent"]?.double,
                directoryName: row["directoryName"]?.string, branch: row["branch"]?.string,
                derivedStatus: row["derivedStatus"]?.string, manualStatus: row["manualStatus"]?.string,
                workspaceState: row["workspaceState"]?.string, workspacePath: row["workspacePath"]?.string,
                defaultBranch: row["defaultBranch"]?.string, repositoryName: row["repositoryName"]?.string,
                lastTurnEndedAt: endedAt, lastTurnOutcome: outcome,
                isHidden: hidden, pendingQuestion: pending)
        }
    }

    /// The question a chat is stuck on, from its newest few rows: a
    /// question-tool call with no tool_result after it and no turn end or human
    /// message after it. Only the newest rows are read (session_id index), and
    /// only rows that could matter carry their body. Port of
    /// `pendingQuestionFor` in conductor-registry.ts.
    func pendingQuestion(sessionId: String) -> String? {
        let sql = """
            SELECT CASE
              WHEN content LIKE '{"type":"assistant"%' AND (
                   content LIKE '%"name":"mcp__conductor__AskUserQuestion"%'
                OR content LIKE '%"name":"AskUserQuestion"%'
                OR content LIKE '%"name":"ExitPlanMode"%') THEN content
              WHEN content LIKE '{"type":"user"%' THEN substr(content, 1, 600)
              WHEN content LIKE '{"type":"result"%' OR content LIKE '{"type":"error"%' THEN '{"type":"result"}'
              ELSE NULL
            END AS body
            FROM (
              SELECT rowid, content FROM session_messages
              WHERE session_id = ? ORDER BY rowid DESC LIMIT 12
            )
            ORDER BY rowid DESC
            """
        guard let rows = try? database.query(sql, [.text(sessionId)]) else { return nil }
        var answered = Set<String>()
        for row in rows {
            guard let body = row["body"]?.string else { continue }
            if body.hasPrefix(#"{"type":"result""#) || body.hasPrefix(#"{"type":"error""#) { return nil }
            if body.hasPrefix(#"{"type":"user""#) {
                // A human message after the question: the turn moved on without it.
                if !body.contains(#""type":"tool_result""#) && !body.contains("<task-notification>") { return nil }
                for id in PendingQuestion.toolUseIds(in: body) { answered.insert(id) }
                continue
            }
            if let call = PendingQuestion.call(inEnvelope: body), !answered.contains(call.id) {
                return call.detail
            }
        }
        return nil
    }

    /// Newest first. Ordered by `datetime()` so both timestamp spellings sort by
    /// real recency, with `rowid` breaking ties within a second.
    public func listSessionMessages(sessionId: String, limit: Int) throws -> [SessionMessageRecord] {
        let sql = """
            SELECT id, role, content, sent_at as sentAt, turn_id as turnId, model
            FROM session_messages
            WHERE session_id = ?
              AND cancelled_at IS NULL
            ORDER BY datetime(COALESCE(sent_at, created_at)) DESC, rowid DESC
            LIMIT ?
            """
        return try database.query(sql, [.text(sessionId), .int(Int64(limit))]).compactMap { row in
            guard let role = row["role"]?.string, let content = row["content"]?.string else { return nil }
            return SessionMessageRecord(
                id: row["id"]?.string, role: role, content: content, sentAt: row["sentAt"]?.string,
                turnId: row["turnId"]?.string, model: row["model"]?.string)
        }
    }
}

// MARK: - Status mapping (port of src/fleet/observers/conductor.ts and active.ts)

public enum ConductorStatus {
    /// An idle chat this recent counts as freshly finished.
    public static let finishedWithin: TimeInterval = 6 * 60 * 60
    /// How long a finished session stays on screen.
    public static let recentlyFinished: TimeInterval = 15 * 60

    public static func state(of row: ConductorSessionRow, now: Date) -> SessionState {
        // Conductor keeps `working` while its question modal is open; the only
        // trace is an unanswered question-tool call in the chat's newest rows.
        if row.pendingQuestion != nil, !row.isHidden { return .blocked }
        switch row.status {
        // `waiting`: the turn ended but background work is still running, so
        // the chat is not done.
        case "working", "cancelling", "waiting": return .working
        case "needs_user_input", "needs_plan_response": return .blocked
        case "error": return .error
        default: break
        }
        // A chat the user never spoke in never ran.
        guard let userAt = ConductorTime.date(row.lastUserMessageAt) else { return .idle }
        guard let endedIso = row.lastTurnEndedAt, let ended = ConductorTime.date(endedIso),
              row.lastTurnOutcome != .aborted
        else { return .idle }
        // You spoke after the last turn ended: that turn was stopped or dropped.
        if userAt > ended { return .idle }
        if row.lastTurnOutcome == .failed { return .error }
        return now.timeIntervalSince(ended) <= finishedWithin ? .finished : .idle
    }

    /// A workspace the user already finished with, or a chat they closed.
    public static func isRetired(_ row: ConductorSessionRow) -> Bool {
        if row.isHidden { return true }
        let manual = row.manualStatus?.trimmingCharacters(in: .whitespaces).lowercased()
        if manual == "canceled" || manual == "cancelled" || manual == "done" { return true }
        if row.workspaceState?.trimmingCharacters(in: .whitespaces).lowercased() == "archived" { return true }
        return row.derivedStatus?.trimmingCharacters(in: .whitespaces).lowercased() == "done"
    }

    /// When the session last did something: a running one by its row clock, a
    /// resting one by its content (last turn end or message), so a bulk touch
    /// cannot make an old chat look fresh.
    public static func activityTime(of row: ConductorSessionRow, state: SessionState) -> Date? {
        if state == .working || state == .blocked { return ConductorTime.date(row.updatedAt) }
        let candidates = [row.lastTurnEndedAt, row.lastUserMessageAt].compactMap { ConductorTime.date($0) }
        return candidates.max() ?? ConductorTime.date(row.updatedAt)
    }

    /// Port of `isActiveSession` for Conductor chats: retired never; working or
    /// blocked always; finished/error for 15 minutes; idle never (Conductor
    /// keeps warm processes for hours, so liveness means nothing here).
    public static func isActive(state: SessionState, retired: Bool, lastActivityAt: Date?, now: Date) -> Bool {
        if retired { return false }
        switch state {
        case .working, .blocked: return true
        case .finished, .error:
            guard let at = lastActivityAt else { return false }
            return now.timeIntervalSince(at) < recentlyFinished
        case .idle, .unknown: return false
        }
    }

    /// Conductor stores this as a float that is sometimes absent and sometimes 0.
    public static func normalizePercent(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return max(0, min(100, value))
    }
}
