import Foundation
import SQLite3
@testable import SqueakMacCore

/// A throwaway Conductor database with only the columns Squeak reads. Written
/// with a separate read-write handle; the code under test never writes.
final class ConductorFixture {
    let dir: URL
    let dbPath: String
    private var db: OpaquePointer?

    init() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("conductor-fixture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        dbPath = dir.appendingPathComponent("conductor.db").path
        guard sqlite3_open(dbPath, &db) == SQLITE_OK else { throw ConductorDatabaseError.unreadable("fixture open") }
        try exec(
            """
            CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, default_branch TEXT, hidden INTEGER DEFAULT 0);
            CREATE TABLE workspaces (
              id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT,
              derived_status TEXT, manual_status TEXT, workspace_path TEXT);
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, agent_type TEXT, title TEXT,
              claude_session_id TEXT, last_user_message_at TEXT, context_used_percent FLOAT,
              created_at TEXT, updated_at TEXT, is_hidden INTEGER DEFAULT 0);
            CREATE TABLE session_messages (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
              sent_at TEXT, turn_id TEXT, model TEXT, created_at TEXT, cancelled_at TEXT);
            CREATE INDEX idx_msg_session ON session_messages(session_id);
            INSERT INTO repos (id, name, default_branch) VALUES ('r1', 'squeak', 'main');
            INSERT INTO workspaces (id, repository_id, directory_name, branch, state, workspace_path)
              VALUES ('w1', 'r1', 'ushuaia', 'feature', 'ready', '/w/ushuaia');
            """)
    }

    deinit {
        sqlite3_close(db)
        try? FileManager.default.removeItem(at: dir)
    }

    var database: ConductorDatabase { ConductorDatabase(path: dbPath) }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let m = err.map { String(cString: $0) } ?? "?"
            throw ConductorDatabaseError.query(m)
        }
    }

    func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "''") + "'" }
    func lit(_ s: String?) -> String { s.map(q) ?? "NULL" }

    func addSession(
        _ id: String, workspace: String = "w1", status: String = "idle", agent: String = "claude",
        title: String = "A chat", claudeSessionId: String? = nil, lastUser: String? = nil,
        updatedAt: String = "2026-10-18T10:00:00.000Z", hidden: Bool = false
    ) throws {
        try exec(
            """
            INSERT INTO sessions (id, workspace_id, status, agent_type, title, claude_session_id,
              last_user_message_at, created_at, updated_at, is_hidden)
            VALUES (\(q(id)), \(q(workspace)), \(q(status)), \(q(agent)), \(q(title)), \(lit(claudeSessionId)),
              \(lit(lastUser)), \(q(updatedAt)), \(q(updatedAt)), \(hidden ? 1 : 0))
            """)
    }

    @discardableResult
    func addMessage(
        _ session: String, role: String, content: String, sentAt: String?, turn: String? = nil,
        id: String = UUID().uuidString
    ) throws -> String {
        try exec(
            """
            INSERT INTO session_messages (id, session_id, role, content, sent_at, turn_id, created_at)
            VALUES (\(q(id)), \(q(session)), \(q(role)), \(q(content)), \(lit(sentAt)), \(lit(turn)), \(lit(sentAt)))
            """)
        return id
    }

    static func envelope(_ blocks: [[String: Any]]) -> String {
        let obj: [String: Any] = ["type": "assistant", "message": ["role": "assistant", "content": blocks]]
        return String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!
    }
    static func text(_ t: String) -> [String: Any] { ["type": "text", "text": t] }
}
