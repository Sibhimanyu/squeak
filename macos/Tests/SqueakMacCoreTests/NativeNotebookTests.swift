import Foundation
import Testing
@testable import SqueakMacCore

private final class Replier: HTTPTransport, @unchecked Sendable {
    var last: HTTPRequest?
    let reply: String
    init(_ reply: String) { self.reply = reply }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        last = request
        return HTTPResponse(status: 200, body: Data(reply.utf8))
    }
}

@Suite struct NativeNotebookTests {
    private static let json = #"{"entries":[{"id":"a","text":"Run npm run ci.","by":"Pip","createdAt":1,"lastUsedAt":2},{"nope":1},{"id":"b","text":"Mind the cache."}],"maxEntries":5,"maxChars":60}"#

    private func notebook() throws -> NativeNotebook {
        try JSONDecoder().decode(NativeNotebook.self, from: Data(Self.json.utf8))
    }

    @Test func decodesSkippingBadRowsAndKeepingTheCaps() throws {
        let n = try notebook()
        #expect(n.entries.map(\.text) == ["Run npm run ci.", "Mind the cache."])
        #expect(n.entries[0].by == "Pip" && n.entries[1].by == nil)
        #expect(n.maxEntries == 5 && n.maxChars == 60)
        let bare = try JSONDecoder().decode(NativeNotebook.self, from: Data("{}".utf8))
        #expect(bare.entries.isEmpty && bare.maxEntries == 40 && bare.maxChars == 6000)
    }

    @Test func aDraftIsOneLessonALineAndSavesOnlyWhenChanged() throws {
        var d = NotebookDraft(try notebook())
        #expect(d.text == "Run npm run ci.\nMind the cache.")
        #expect(!d.isChanged && !d.canSave)
        d.text += "\n  \n  A new lesson.  \nA new lesson."
        #expect(d.lessons == ["Run npm run ci.", "Mind the cache.", "A new lesson."])
        #expect(d.isChanged && d.canSave)
        d.text = "Run npm run ci.\nMind the cache."
        #expect(!d.isChanged)
    }

    @Test func overTheCapsCannotSaveAndTheSummaryTellsWhy() throws {
        var d = NotebookDraft(try notebook())
        d.text = "1\n2\n3\n4\n5\n6"
        #expect(d.isOverCap && !d.canSave && d.summary.contains("Too long"))
        d.text = String(repeating: "x", count: 61)
        #expect(d.isOverCap)
        d.text = "ok"
        #expect(!d.isOverCap && d.summary == "1 of 5 lessons, 2 of 60 characters")
    }

    @Test func clearingEveryLessonIsAChange() throws {
        var d = NotebookDraft(try notebook())
        d.text = ""
        #expect(d.lessons.isEmpty && d.canSave)
    }

    @Test func routesReadAndReplaceTheHostNotebook() async throws {
        let t = Replier(Self.json)
        let c = NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" })
        let n = try await c.notebook(projectId: "p1")
        #expect(t.last?.method == "GET" && t.last?.url.path == "/native/projects/p1/notebook" && n.entries.count == 2)
        _ = try await c.saveNotebook(projectId: "p1", lessons: ["a", "b"])
        #expect(t.last?.method == "PUT" && t.last?.url.path == "/native/projects/p1/notebook")
        let sent = try JSONSerialization.jsonObject(with: t.last?.body ?? Data()) as? [String: [String]]
        #expect(sent?["entries"] == ["a", "b"])
    }
}
