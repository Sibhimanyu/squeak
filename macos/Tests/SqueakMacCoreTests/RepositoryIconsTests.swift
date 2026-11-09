import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Repository artwork")
struct RepositoryIconsTests {
    @Test func readsConductorArtworkAndIgnoresMissingOrUnsupportedIcons() throws {
        let fixture = try ConductorFixture()
        try fixture.exec("ALTER TABLE repos ADD COLUMN icon TEXT")
        try fixture.exec("UPDATE repos SET icon = 'data:image/png;base64,AQID' WHERE name = 'squeak'")
        try fixture.exec("INSERT INTO repos (id, name, icon) VALUES ('r2', 'empty', NULL), ('r3', 'remote', 'https://example.com/icon.png')")
        #expect(RepositoryIcons.read(database: fixture.database) == ["squeak": Data([1, 2, 3])])
        // Reading icons must leave Conductor's own artwork unchanged.
        #expect(try fixture.database.query("SELECT icon FROM repos WHERE name = 'squeak'").first?["icon"]?.string == "data:image/png;base64,AQID")
    }

    @Test func olderSchemaAndMissingDatabaseFallBackWithoutError() throws {
        let fixture = try ConductorFixture()
        #expect(RepositoryIcons.read(database: fixture.database).isEmpty)
        #expect(RepositoryIcons.read(database: ConductorDatabase(path: fixture.dbPath + ".missing")).isEmpty)
    }

    @Test func invalidOrOversizedDataIsRejected() {
        #expect(RepositoryIcons.decode("data:image/png;base64,???") == nil)
        #expect(RepositoryIcons.decode("data:image/png;base64,") == nil)
        #expect(RepositoryIcons.decode("data:image/svg+xml;base64,AQID") == nil)
        #expect(RepositoryIcons.decode("data:image/png;base64," + String(repeating: "A", count: 2_800_001)) == nil)
    }
}
