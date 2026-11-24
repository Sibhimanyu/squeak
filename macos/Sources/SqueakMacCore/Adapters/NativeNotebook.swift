import Foundation

/// The Pond's shared Notebook: lessons every Duck reads when it takes a Task (host `pond-notebook.ts`,
/// `GET/PUT /native/projects/<id>/notebook`). The Owner reads and edits it from the Pond's settings.
public struct NativeNotebook: Sendable, Equatable, Decodable {
    public struct Entry: Sendable, Equatable, Decodable, Identifiable {
        public var id: String
        public var text: String
        public var by: String?
        public init(id: String, text: String, by: String? = nil) { self.id = id; self.text = text; self.by = by }
    }

    public var entries: [Entry]
    /// What the host keeps: lessons and characters in all (it refuses an edit past either).
    public var maxEntries: Int
    public var maxChars: Int

    public init(entries: [Entry] = [], maxEntries: Int = 40, maxChars: Int = 6000) {
        self.entries = entries; self.maxEntries = maxEntries; self.maxChars = maxChars
    }

    enum CodingKeys: String, CodingKey { case entries, maxEntries, maxChars }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = c.lenient([Failable<Entry>].self, .entries)?.compactMap(\.value) ?? []
        maxEntries = c.lenient(Int.self, .maxEntries) ?? 40
        maxChars = c.lenient(Int.self, .maxChars) ?? 6000
    }
}

/// The Owner's edit of the Notebook: one lesson a line. Only draws and counts; the host decides what it keeps.
public struct NotebookDraft: Sendable, Equatable {
    public var text: String
    private let original: [String]
    public let maxEntries: Int
    public let maxChars: Int

    public init(_ notebook: NativeNotebook) {
        original = notebook.entries.map(\.text)
        text = original.joined(separator: "\n")
        maxEntries = notebook.maxEntries
        maxChars = notebook.maxChars
    }

    /// The lessons as the host would read them: lines trimmed, blanks and repeats dropped.
    public var lessons: [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public var characterCount: Int { lessons.reduce(0) { $0 + $1.count } }

    public var isChanged: Bool { lessons != original }

    public var isOverCap: Bool { lessons.count > maxEntries || characterCount > maxChars }

    public var canSave: Bool { isChanged && !isOverCap }

    /// One line under the editor: how full the Notebook is, and what to do when it is too full.
    public var summary: String {
        let n = lessons.count
        let count = "\(n) of \(maxEntries) lessons, \(characterCount) of \(maxChars) characters"
        return isOverCap ? "\(count). Too long: remove some lessons to save." : count
    }
}

extension NativeHostClient {
    public func notebook(projectId: String) async throws -> NativeNotebook {
        try JSONDecoder.native(NativeNotebook.self, try await call("GET", "/native/projects/\(Self.id(projectId))/notebook"))
    }

    /// Replaces the Notebook with these lessons, in this order (the host refuses one past its caps, with a sentence).
    public func saveNotebook(projectId: String, lessons: [String]) async throws -> NativeNotebook {
        let body: NativeJSON = .object(["entries": .array(lessons.map { .string($0) })])
        return try JSONDecoder.native(
            NativeNotebook.self,
            try await call("PUT", "/native/projects/\(Self.id(projectId))/notebook", body: body, timeout: 15))
    }
}
