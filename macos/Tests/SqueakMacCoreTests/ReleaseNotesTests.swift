import Testing
@testable import SqueakMacCore

@Suite("Release notes")
struct ReleaseNotesTests {
    @Test func bulletsFromList() {
        let html = "<html><head><style>li{x:y}</style></head><body><ul><li>One &amp; <code>two</code></li><li>\n Three\n  line </li></ul></body></html>"
        #expect(ReleaseNotes.bullets(fromHTML: html) == ["One & two", "Three line"])
    }

    @Test func alsoInSectionsAreCutOff() {
        let html = "<body><ul><li>New</li></ul><h4>Also in 2.5.0</h4><ul><li>Old</li></ul></body>"
        #expect(ReleaseNotes.bullets(fromHTML: html) == ["New"])
    }

    @Test func emptyAndMissing() {
        #expect(ReleaseNotes.bullets(fromHTML: nil).isEmpty)
        #expect(ReleaseNotes.bullets(fromHTML: "").isEmpty)
        #expect(ReleaseNotes.bullets(fromHTML: "<p>No list</p>").isEmpty)
    }

    @Test func escapedMarkupStaysText() {
        #expect(ReleaseNotes.bullets(fromHTML: "<ul><li>a &lt;b&gt; c</li></ul>") == ["a <b> c"])
    }
}
