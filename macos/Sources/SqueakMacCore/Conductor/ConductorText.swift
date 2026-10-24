import Foundation

/// Text extraction from Conductor's `session_messages` rows (ports of
/// `src/utils/conductor-envelope.ts` and `src/fleet/transcript.ts`). Only user
/// text and assistant prose survive: tool calls and results, thinking, and
/// `result` / `system` events never leave this file.
public enum ConductorText {
    /// Rows read to build a transcript; tool calls and results are most of them.
    public static let transcriptScanRows = 600
    public static let lastTurnScanRows = 200
    /// Rows in the first read of a page: most chats keep their last messages within a couple of hundred.
    public static let firstChunkRows = 200
    /// Rows per read after that.
    public static let chunkRows = 2_000
    /// A chat is never scanned further than this in one request; the page then says it is not complete.
    public static let maxScanRows = 40_000

    private static func parse(_ content: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(content.utf8), options: [.fragmentsAllowed])
    }

    private static func blank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private static func joinTextBlocks(_ blocks: [Any]) -> String? {
        let text = blocks.compactMap { block -> String? in
            guard let r = block as? [String: Any], r["type"] as? String == "text", let t = r["text"] as? String,
                  !blank(t) else { return nil }
            return t
        }.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// The prose of an assistant row; nil for tool-only rows, results and events.
    public static func assistantText(_ content: String) -> String? {
        guard let parsed = parse(content) else {
            // Not JSON: older rows stored bare text.
            let bare = content.trimmingCharacters(in: .whitespacesAndNewlines)
            return bare.isEmpty ? nil : bare
        }
        guard let message = (parsed as? [String: Any])?["message"] as? [String: Any],
              let blocks = message["content"] as? [Any] else { return nil }
        return joinTextBlocks(blocks)
    }

    /// What the human typed. Mirrored rows are plain text; Conductor's own rows
    /// may be an envelope. A block list of only tool results is plumbing.
    public static func userText(_ content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = parse(content) else { return trimmed.isEmpty ? nil : trimmed }
        guard let message = (parsed as? [String: Any])?["message"] as? [String: Any] else {
            // JSON that is not an envelope (the user typed "42" or a snippet).
            return parsed is [String: Any] ? nil : (trimmed.isEmpty ? nil : trimmed)
        }
        if let body = message["content"] as? String {
            let t = body.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        guard let blocks = message["content"] as? [Any] else { return nil }
        return joinTextBlocks(blocks)
    }

    /// Readable history from rows (newest first, as the registry returns them),
    /// returned oldest first, limited to the newest `limit` messages.
    public static func buildTranscript(rows: [SessionMessageRecord], limit: Int, scanRows: Int = transcriptScanRows)
        -> (messages: [ChatMessage], complete: Bool)
    {
        var kept: [ChatMessage] = []
        for row in rows {
            let role: MessageRole
            let text: String?
            switch row.role {
            case "user": role = .user; text = userText(row.content)
            case "assistant": role = .assistant; text = assistantText(row.content)
            default: continue
            }
            guard let text else { continue }
            kept.append(
                ChatMessage(
                    id: row.id ?? "\(row.turnId ?? "row"):\(kept.count)", role: role, text: text,
                    at: ConductorTime.date(row.sentAt), turnId: row.turnId, cursor: row.cursor.map(String.init)))
        }
        return (Array(kept.prefix(limit).reversed()), rows.count < scanRows && kept.count <= limit)
    }

    /// What the human or the agent said in a row, if anything.
    static func messageText(_ row: SessionMessageRecord) -> String? {
        switch row.role {
        case "user": userText(row.content)
        case "assistant": assistantText(row.content)
        default: nil
        }
    }

    /// A page of readable history: the newest `limit` messages strictly before `before` (nil: from the
    /// newest), found by reading rows newest first in chunks (200, then 2000) until `limit + 1` messages
    /// turned up or the chat runs out. A turn of hundreds of tool rows cannot hide its own prompt. `nextBefore`
    /// is the cursor for what precedes the page (nil: nothing does).
    public static func readPage(
        before: Int64?, limit: Int, scanCap: Int = maxScanRows,
        readRows: (_ before: Int64?, _ count: Int) throws -> [SessionMessageRecord]
    ) rethrows -> (messages: [ChatMessage], nextBefore: Int64?, complete: Bool) {
        var rows: [SessionMessageRecord] = []
        var cursor = before
        var texts = 0
        var exhausted = false
        while rows.count < scanCap {
            let size = rows.isEmpty ? firstChunkRows : chunkRows
            let chunk = try readRows(cursor, size)
            texts += chunk.reduce(0) { $0 + (messageText($1) == nil ? 0 : 1) }
            rows.append(contentsOf: chunk)
            guard chunk.count >= size, let last = chunk.last?.cursor else { exhausted = true; break }
            cursor = last
            if texts > limit { break }
        }
        let built = buildTranscript(rows: rows, limit: limit)
        var next: Int64?
        if texts > limit, let oldest = built.messages.first?.cursor.flatMap(Int64.init) {
            next = oldest
        } else if !exhausted {
            // Scan cap hit without enough messages: resume below everything read.
            next = rows.last?.cursor
        }
        return (built.messages, next, next == nil)
    }

    /// The prose of the chat's latest turn: the newest text block of the newest
    /// turn, or nil when the newest row is not the assistant's (a turn that has
    /// just started must not resurface the previous turn's question).
    public static func lastTurnText(rows: [SessionMessageRecord]) -> String? {
        guard let latest = rows.first, latest.role == "assistant" else { return nil }
        for row in rows {
            if row.role != "assistant" || row.turnId != latest.turnId { break }
            if let text = assistantText(row.content) { return text }
        }
        return nil
    }
}

extension ConductorRegistry {
    /// The newest `limit` messages (oldest first), with whether the whole chat is in them.
    public func transcript(sessionId: String, limit: Int) throws -> (messages: [ChatMessage], complete: Bool) {
        let page = try transcriptPage(sessionId: sessionId, limit: limit, before: nil)
        return (page.messages, page.complete)
    }

    public func transcriptPage(sessionId: String, limit: Int, before: Int64?) throws
        -> (messages: [ChatMessage], nextBefore: Int64?, complete: Bool)
    {
        try ConductorText.readPage(before: before, limit: limit) { cursor, count in
            try listSessionMessagesPage(sessionId: sessionId, before: cursor, limit: count)
        }
    }

    public func lastTurnText(sessionId: String) throws -> String? {
        ConductorText.lastTurnText(rows: try listSessionMessages(sessionId: sessionId, limit: ConductorText.lastTurnScanRows))
    }
}
