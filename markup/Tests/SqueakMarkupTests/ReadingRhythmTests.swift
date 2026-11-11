import Testing
@testable import SqueakMarkup

@Suite("Reading rhythm")
struct ReadingRhythmTests {
    typealias M = MessageMarkup

    private var reading: MessageStyle {
        var s = MessageStyle.mac; s.bodySize = 14
        s.paragraphGap = 1.15; s.listGap = 1.0; s.headingGapAbove = 1.6; s.headingGapBelow = 0.7; s.listItemGap = 6
        return s
    }
    private let para = M.Block.paragraph([.text("a")])
    private let item = M.Block.listItem(marker: .bullet, depth: 0, [.text("x")])
    private let nested = M.Block.listItem(marker: .bullet, depth: 1, [.text("y")])

    @Test func defaultsKeepTheOldRhythm() {
        let s = MessageStyle.mac
        #expect(MessageLayout.gap(from: para, to: para, em: 10, style: s) == 6)
        #expect(MessageLayout.gap(from: item, to: item, em: 10, style: s) == 3)
        #expect(MessageLayout.gap(from: item, to: nested, em: 10, style: s) == 2.2)
        #expect(MessageLayout.gap(from: para, to: .heading(level: 2, [.text("h")]), em: 10, style: s) == 13)
    }

    @Test func aParagraphGapIsBiggerThanTheLineGapAndAListGetsRoomAround() {
        let s = reading
        let gap = MessageLayout.gap(from: para, to: para, em: 14, style: s)
        #expect(gap > 14 * 1.0)
        #expect(MessageLayout.gap(from: para, to: item, em: 14, style: s) == 14)
        #expect(MessageLayout.gap(from: item, to: para, em: 14, style: s) == 14)
        #expect(MessageLayout.gap(from: para, to: .heading(level: 2, [.text("h")]), em: 14, style: s) == 14 * 1.6)
        #expect(MessageLayout.gap(from: .heading(level: 2, [.text("h")]), to: para, em: 14, style: s) == 14 * 0.7)
    }

    @Test func listItemsAreEvenlySpacedAtEveryDepth() {
        let s = reading
        #expect(MessageLayout.gap(from: item, to: item, em: 14, style: s) == 6)
        #expect(MessageLayout.gap(from: item, to: nested, em: 14, style: s) == 6)
        #expect(MessageLayout.gap(from: nested, to: item, em: 14, style: s) == 6)
    }

    @Test func optionLinesAreAListOnlyWhenAsked() {
        let text = "Which one?\n\nA) Keep it\nB) Drop it (recommended)\nC) Something else"
        let on = M.parse(text, letteredOptions: true)
        #expect(on.count == 4)
        #expect(on[1] == .listItem(marker: .letter("A"), depth: 0, [.text("Keep it")]))
        // "(recommended)" is glued to the word before it with a no-break space.
        #expect(on[2] == .listItem(marker: .letter("B"), depth: 0, [.text("Drop it\u{00A0}(recommended)")]))
        let off = M.parse(text)
        #expect(off.count == 2)
        guard case .paragraph = off[1] else { Issue.record("expected a paragraph"); return }
    }

    @Test func onlyLettersAToHAreOptions() {
        #expect(M.parse("Z) no", letteredOptions: true) == [.paragraph([.text("Z) no")])])
        #expect(M.parse("a) no", letteredOptions: true) == [.paragraph([.text("a) no")])])
    }

    @Test func aLongPathBreaksOnlyAfterSlashes() {
        let path = "/Users/sibhi/conductor/workspaces/squeak/ushuaia/file.swift"
        let out = MessageLayout.breakablePath(path)
        #expect(out.replacingOccurrences(of: "\u{200B}", with: "") == path)
        #expect(out.hasPrefix("/\u{200B}Users/\u{200B}sibhi/"))
        #expect(out.components(separatedBy: "\u{200B}").count == path.filter { $0 == "/" }.count + 1)
        #expect(MessageLayout.breakablePath("a/b") == "a/b")
        #expect(MessageLayout.breakablePath("some-long-identifier-without-slash") == "some-long-identifier-without-slash")
        #expect(MessageLayout.breakablePath("https://example.com/a/very/long/address/here").hasPrefix("https://\u{200B}example.com/\u{200B}a/"))
    }
}
