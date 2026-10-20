import Foundation
import SQLite3

/// A value read from SQLite.
public enum SQLValue: Sendable, Equatable {
    case null
    case int(Int64)
    case double(Double)
    case text(String)

    public var string: String? {
        switch self {
        case .text(let s): s
        case .int(let i): String(i)
        case .double(let d): String(d)
        case .null: nil
        }
    }

    public var int: Int64? {
        switch self {
        case .int(let i): i
        case .double(let d): Int64(d)
        case .text(let s): Int64(s)
        case .null: nil
        }
    }

    public var double: Double? {
        switch self {
        case .double(let d): d
        case .int(let i): Double(i)
        case .text(let s): Double(s)
        case .null: nil
        }
    }
}

public typealias SQLRow = [String: SQLValue]

public enum ConductorDatabaseError: Error, Equatable, Sendable {
    case missing(String)
    case unreadable(String)
    case query(String)
}

/// Conductor's database, opened strictly read-only: `SQLITE_OPEN_READONLY`, a
/// `?mode=ro` URI and `PRAGMA query_only=1`. Nothing in Squeak ever writes to
/// it, and a write attempted through this type fails inside SQLite.
///
/// A connection is opened per call. Conductor writes the file constantly (WAL),
/// and a short-lived reader never pins a stale snapshot or holds the file.
public struct ConductorDatabase: Sendable {
    public static var defaultPath: String {
        NSString(string: "~/Library/Application Support/com.conductor.app/conductor.db").expandingTildeInPath
    }

    public let path: String
    public let busyTimeoutMs: Int32

    public init(path: String = ConductorDatabase.defaultPath, busyTimeoutMs: Int32 = 2000) {
        self.path = path
        self.busyTimeoutMs = busyTimeoutMs
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: path) }

    /// Runs one statement and returns its rows. Any statement that would write
    /// throws `.query` (the connection is read-only).
    public func query(_ sql: String, _ binds: [SQLValue] = []) throws -> [SQLRow] {
        guard exists else { throw ConductorDatabaseError.missing(path) }
        var db: OpaquePointer?
        let uri = URL(fileURLWithPath: path).absoluteString + "?mode=ro"
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(uri, &db, flags, nil) == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            if let db { sqlite3_close(db) }
            throw ConductorDatabaseError.unreadable(message)
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, busyTimeoutMs)
        guard sqlite3_exec(db, "PRAGMA query_only=1", nil, nil, nil) == SQLITE_OK else {
            throw ConductorDatabaseError.unreadable(String(cString: sqlite3_errmsg(db)))
        }

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw ConductorDatabaseError.query(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(statement) }

        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in binds.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case .null: sqlite3_bind_null(statement, position)
            case .int(let i): sqlite3_bind_int64(statement, position, i)
            case .double(let d): sqlite3_bind_double(statement, position, d)
            case .text(let s): sqlite3_bind_text(statement, position, s, -1, transient)
            }
        }

        var rows: [SQLRow] = []
        let columnCount = sqlite3_column_count(statement)
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else {
                throw ConductorDatabaseError.query(String(cString: sqlite3_errmsg(db)))
            }
            var row: SQLRow = [:]
            for column in 0..<columnCount {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(statement, column))
                case SQLITE_FLOAT: row[name] = .double(sqlite3_column_double(statement, column))
                case SQLITE_TEXT:
                    row[name] = .text(String(cString: sqlite3_column_text(statement, column)))
                case SQLITE_NULL: row[name] = .null
                default: row[name] = .null  // blobs are never used by the queries Squeak runs
                }
            }
            rows.append(row)
        }
        return rows
    }
}
