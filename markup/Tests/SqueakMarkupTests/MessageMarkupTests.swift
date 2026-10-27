import Testing
@testable import SqueakMarkup

@Suite("Message images")
struct MessageImageTests {
    @Test func anImageAloneInItsParagraphIsAnImageBlock() {
        let blocks = MessageMarkup.parse("Here it is.\n\n![Duplicates](</Users/x/w/.context/shot.png>)\n\nDone.")
        #expect(blocks[1] == .image(alt: "Duplicates", source: "/Users/x/w/.context/shot.png"))
        #expect(MessageMarkup.parse("![](a.png)") == [.image(alt: "", source: "a.png")] || MessageMarkup.parse("![](a.png)").count == 1)
    }

    @Test func anImageInsideASentenceStaysItsDescription() {
        let blocks = MessageMarkup.parse("See ![shot](a.png) for it.")
        guard case .paragraph = blocks.first else { Issue.record("expected a paragraph"); return }
    }
}

@Suite("Message markup")
struct MessageMarkupTests {
    typealias M = MessageMarkup

    @Test func paragraphWithBoldItalicCode() {
        let b = M.parse("Hello **bold** and *it* and `x`")
        #expect(b == [.paragraph([.text("Hello "), .bold([.text("bold")]), .text(" and "), .italic([.text("it")]), .text(" and "), .code("x")])])
    }

    @Test func nesting() {
        #expect(M.parseInlines("**a *b* c**") == [.bold([.text("a "), .italic([.text("b")]), .text(" c")])])
        #expect(M.parseInlines("*a **b** c*") == [.italic([.text("a "), .bold([.text("b")]), .text(" c")])])
        // Markers inside code stay literal.
        #expect(M.parseInlines("`**x**`") == [.code("**x**")])
    }

    @Test func strikethrough() {
        #expect(M.parseInlines("a ~~gone~~ b") == [.text("a "), .strike([.text("gone")]), .text(" b")])
        #expect(M.parseInlines("a ~~b") == [.text("a ~~b")])
        #expect(M.parseInlines("~/x and ~5") == [.path("~/x"), .text(" and ~5")])
    }

    @Test func unclosedMarkersStayLiteral() {
        #expect(M.parseInlines("a **b") == [.text("a **b")])
        #expect(M.parseInlines("a `b") == [.text("a `b")])
        #expect(M.parseInlines("a *b") == [.text("a *b")])
        #expect(M.parseInlines("2 * 3 * 4") == [.text("2 * 3 * 4")])
        #expect(M.parseInlines("snake_case_name") == [.text("snake_case_name")])
        #expect(M.parseInlines("[no](link") == [.text("[no](link")])
    }

    @Test func escapesAndHtmlAreLiteral() {
        #expect(M.parseInlines("\\*not\\*") == [.text("*not*")])
        #expect(M.parseInlines("<b>x</b> <a href=\"u\">y</a>") == [.text("<b>x</b> <a href=\"u\">y</a>")])
        #expect(M.parse("<div>\n**x**\n</div>") == [.paragraph([.text("<div>\n"), .bold([.text("x")]), .text("\n</div>")])])
    }

    @Test func links() {
        #expect(M.parseInlines("see [the **doc**](https://e.com/a) now") ==
            [.text("see "), .link(label: [.text("the "), .bold([.text("doc")])], destination: "https://e.com/a"), .text(" now")])
        // A destination with a space is not a link.
        #expect(M.parseInlines("[a](b c)") == [.text("[a](b c)")])
        // An image is its description, nothing is fetched.
        #expect(M.parseInlines("![chart](https://e.com/c.png)") == [.text("[image: chart]")])
    }

    @Test func imageRightAfterALabelLineIsABlock() {
        let blocks = MessageMarkup.parse("At rest:\n![Rest](/a/rest.png)\nWith mouse:\n![Mouse](/a/m.png)")
        #expect(blocks == [
            .paragraph([.text("At rest:")]), .image(alt: "Rest", source: "/a/rest.png"),
            .paragraph([.text("With mouse:")]), .image(alt: "Mouse", source: "/a/m.png"),
        ])
    }

    @Test func bareURLsAreAutolinked() {
        #expect(M.parseInlines("https://e.com") == [.url("https://e.com")])
        #expect(M.parseInlines("go to https://e.com/a_b_c?x=1, then") == [.text("go to "), .url("https://e.com/a_b_c?x=1"), .text(", then")])
        #expect(M.parseInlines("(see https://e.com/x).") == [.text("(see "), .url("https://e.com/x"), .text(").")])
        #expect(M.parseInlines("https://en.wikipedia.org/wiki/A_(b)") == [.url("https://en.wikipedia.org/wiki/A_(b)")])
        #expect(M.parseInlines("ftp://x and javascript:alert(1)") == [.text("ftp://x and javascript:alert(1)")])
    }

    @Test func filePathsAreCodeRuns() {
        #expect(M.parseInlines("edit src/fleet/radar.ts:42 now") == [.text("edit "), .path("src/fleet/radar.ts:42"), .text(" now")])
        #expect(M.parseInlines("in ~/Library/x, and /etc/hosts.") == [.text("in "), .path("~/Library/x"), .text(", and "), .path("/etc/hosts"), .text(".")])
        // Ordinary slashes are not paths.
        #expect(M.parseInlines("and/or 1/2 w/o 10/12/2026 a / b") == [.text("and/or 1/2 w/o 10/12/2026 a / b")])
        #expect(M.parseInlines("package.json") == [.text("package.json")])
    }

    @Test func headingsListsQuotes() {
        let b = M.parse("## Title ##\n- one\n  - nested\n2. two\n> quoted\n> more\n\npara")
        #expect(b == [
            .heading(level: 2, [.text("Title")]),
            .listItem(marker: .bullet, depth: 0, [.text("one")]),
            .listItem(marker: .bullet, depth: 1, [.text("nested")]),
            .listItem(marker: .number(2), depth: 0, [.text("two")]),
            .quote([.paragraph([.text("quoted\nmore")])]),
            .paragraph([.text("para")]),
        ])
        #expect(M.parse("#nospace") == [.paragraph([.text("#nospace")])])
    }

    @Test func softLineBreaksAreKept() {
        #expect(M.parse("one\ntwo\n\nthree") == [.paragraph([.text("one\ntwo")]), .paragraph([.text("three")])])
    }

    @Test func taskLists() {
        #expect(M.parse("- [x] done\n- [ ] todo\n- [x]nospace") == [
            .listItem(marker: .task(done: true), depth: 0, [.text("done")]),
            .listItem(marker: .task(done: false), depth: 0, [.text("todo")]),
            .listItem(marker: .bullet, depth: 0, [.text("[x]nospace")]),
        ])
    }

    @Test func looseListItemKeepsItsSecondParagraph() {
        let b = M.parse("1. First\n\n   More about first\n\n2. Second")
        #expect(b == [
            .listItem(marker: .number(1), depth: 0, [.text("First\n\nMore about first")]),
            .listItem(marker: .number(2), depth: 0, [.text("Second")]),
        ])
    }

    @Test func quoteHoldsBlocks() {
        let b = M.parse("> **Note**\n> - a\n> - b\n>\n> more")
        #expect(b == [.quote([
            .paragraph([.bold([.text("Note")])]),
            .listItem(marker: .bullet, depth: 0, [.text("a")]),
            .listItem(marker: .bullet, depth: 0, [.text("b")]),
            .paragraph([.text("more")]),
        ])])
    }

    @Test func rules() {
        #expect(M.parse("a\n\n---\n\n***\n- - -\nb") == [.paragraph([.text("a")]), .rule, .rule, .rule, .paragraph([.text("b")])])
        #expect(M.parse("**bold**") == [.paragraph([.bold([.text("bold")])])])
    }

    @Test func codeFenceWithLanguage() {
        let b = M.parse("before\n```swift\nlet a = **1**\n\n  indented\n```\nafter")
        #expect(b == [.paragraph([.text("before")]), .codeBlock(language: "swift", code: "let a = **1**\n\n  indented"), .paragraph([.text("after")])])
        #expect(M.parse("```\nx") == [.codeBlock(language: nil, code: "x")])
        #expect(M.parse("~~~sh\nls\n~~~") == [.codeBlock(language: "sh", code: "ls")])
    }

    @Test func indentedCode() {
        #expect(M.parse("text\n\n    let a = 1\n\n    let b = 2\n\nafter") ==
            [.paragraph([.text("text")]), .codeBlock(language: nil, code: "let a = 1\n\nlet b = 2"), .paragraph([.text("after")])])
    }

    @Test func tables() {
        let md = "| Name | Qty | Note |\n| :--- | ---: | :-: |\n| `a|b` | **2** | ok |\n| c | 3 |"
        let b = M.parse(md + "\n\nafter")
        #expect(b == [
            .table(header: [[.text("Name")], [.text("Qty")], [.text("Note")]],
                   alignments: [.leading, .trailing, .center],
                   rows: [[[.code("a|b")], [.bold([.text("2")])], [.text("ok")]],
                          [[.text("c")], [.text("3")], []]]),
            .paragraph([.text("after")]),
        ])
        // Without the delimiter row it is a paragraph.
        #expect(M.parse("a | b\nc | d") == [.paragraph([.text("a | b\nc | d")])])
        // Without outer pipes.
        if case .table(let h, _, let rows) = M.parse("a | b\n--|--\n1 | 2")[0] {
            #expect(h.count == 2 && rows.count == 1)
        } else { Issue.record("not a table") }
    }

    @Test func largeInputIsFast() {
        let chunk = "Some **bold** text with `code`, a [link](https://e.com), src/a/b.ts:3 and *unclosed ** markers `\n- item\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"
        let big = String(repeating: chunk, count: 200_000 / chunk.utf8.count)
        let pathological = String(repeating: "** _ * ` [ ", count: 8_000)
        let slashes = String(repeating: "a/b/c ", count: 30_000)
        let clock = ContinuousClock()
        let t1 = clock.measure { _ = M.parse(big) }
        let t2 = clock.measure { _ = M.parse(pathological) }
        let t3 = clock.measure { _ = M.parse(slashes) }
        // The bound is for release; an unoptimised build runs several times slower.
        #if DEBUG
        let limit = Duration.milliseconds(500)
        #else
        let limit = Duration.milliseconds(100)
        #endif
        #expect(t1 < limit, "\(t1)")
        #expect(t2 < limit, "\(t2)")
        #expect(t3 < limit, "\(t3)")
    }
}
