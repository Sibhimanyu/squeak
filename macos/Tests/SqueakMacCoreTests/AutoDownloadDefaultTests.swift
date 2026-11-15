import Testing
@testable import SqueakMacCore

@Suite struct AutoDownloadDefaultTests {
    @Test func resetsTheOldAppWrittenTrueOnce() {
        #expect(AutoDownloadDefault.migratedValue(stored: true, markerSet: false) == false)
    }
    @Test func keepsAChoiceMadeAfterTheMigration() {
        #expect(AutoDownloadDefault.migratedValue(stored: true, markerSet: true) == nil)
    }
    @Test func leavesOffAndUnsetAlone() {
        #expect(AutoDownloadDefault.migratedValue(stored: false, markerSet: false) == nil)
        #expect(AutoDownloadDefault.migratedValue(stored: nil, markerSet: false) == nil)
    }
}
