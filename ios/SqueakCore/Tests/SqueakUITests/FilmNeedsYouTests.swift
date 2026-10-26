import XCTest
import SqueakCore
@testable import SqueakUI

final class FilmNeedsYouTests: XCTestCase {
    private func call() -> Workflow {
        Workflow(provider: "rasanai", call: "brief", step: "brief", revision: "b@1", title: "T", prompt: "Confirm the brief")
    }

    private func film(_ id: String, state: String = "running", waiting: Bool = true, at: String, sessionKey: String? = nil) -> PhoneFilm {
        PhoneFilm(id: id, title: id, updatedAt: at, director: .init(state: state), card: waiting ? call() : nil, sessionKey: sessionKey)
    }

    private func session(_ key: String, state: String, at: String) -> PhoneSnapshot.Session {
        PhoneSnapshot.Session(key: key, conductorSessionId: key, label: key, agent: "claude", state: state,
                              lastActivityAt: at, detail: nil, git: nil, contextPercent: nil, turnId: nil, message: nil, choices: nil)
    }

    func testAWaitingFilmIsOnThePageNewestFirstWithChats() {
        let sessions = [session("old", state: "awaiting_approval", at: "2026-10-26T08:00:00Z"),
                        session("busy", state: "working", at: "2026-10-26T12:00:00Z")]
        let films = [film("film:a", at: "2026-10-26T10:00:00Z"), film("film:idle", waiting: false, at: "2026-10-26T11:00:00Z"),
                     film("film:done", state: "finished", at: "2026-10-26T11:30:00Z")]
        let entries = NeedsYou.entries(sessions: sessions, films: films)
        XCTAssertEqual(entries.map(\.id), ["film:a", "old"])
        XCTAssertEqual(NeedsYou.count(sessions: sessions, films: films), 2)
    }

    func testAFilmStandsForItsDirectorsChat() {
        let sessions = [session("claude-transcript:d1", state: "awaiting_input", at: "2026-10-26T10:00:00Z")]
        let films = [film("film:a", at: "2026-10-26T09:00:00Z", sessionKey: "claude-transcript:d1")]
        XCTAssertEqual(NeedsYou.entries(sessions: sessions, films: films).map(\.id), ["film:a"])
        // A film that is not waiting leaves its chat alone.
        let quiet = [film("film:a", waiting: false, at: "2026-10-26T09:00:00Z", sessionKey: "claude-transcript:d1")]
        XCTAssertEqual(NeedsYou.entries(sessions: sessions, films: quiet).map(\.id), ["claude-transcript:d1"])
    }

    func testNoFilmsChangesNothing() {
        let sessions = [session("a", state: "awaiting_input", at: "2026-10-26T10:00:00Z")]
        XCTAssertEqual(NeedsYou.entries(sessions: sessions, films: []).map(\.id), ["a"])
        XCTAssertEqual(NeedsYou.count(sessions: [], films: []), 0)
    }
}
