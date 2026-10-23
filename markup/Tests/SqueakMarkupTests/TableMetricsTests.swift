import Testing
@testable import SqueakMarkup

private typealias T = TableMetrics

@Suite struct TableMetricsTests {
    @Test func fitsAtIdealWidthsAndFillsTheBox() {
        let c = T.columns(ideal: [80, 120], minimum: [40, 50], available: 400)
        #expect(!c.scrolls)
        #expect(abs(c.total - 400) < 0.01)
        #expect(c.widths[1] > c.widths[0])
    }

    @Test func aLongColumnWrapsInsteadOfPushingTheRestOff() {
        // The owner's table: a short-ish first column and a very long second one on a 330pt phone.
        let c = T.columns(ideal: [300, 900], minimum: [70, 60], available: 330)
        #expect(!c.scrolls)
        #expect(c.total <= 330.01)
        #expect(c.widths.allSatisfy { $0 >= 64 })
        // Neither column swallows the box.
        #expect(c.widths[1] < 330 * 0.75)
    }

    @Test func columnsNeverGoBelowTheirLongestWord() {
        let c = T.columns(ideal: [500, 500], minimum: [150, 20], available: 330)
        #expect(c.widths[0] >= 150)
        #expect(c.total <= 330.01)
    }

    @Test func tooManyColumnsScrollAtReadableWidths() {
        let c = T.columns(ideal: [200, 200, 200, 200], minimum: [90, 90, 90, 90], available: 330)
        #expect(c.scrolls)
        #expect(c.widths.allSatisfy { $0 >= 90 && $0 <= T.scrollColumnMaximum })
        #expect(c.total > 330)
    }

    @Test func aLongColumnInAScrollingTableStaysCapped() {
        let c = T.columns(ideal: [100, 2000, 100, 100, 100], minimum: [80, 80, 80, 80, 80], available: 300)
        #expect(c.scrolls)
        #expect(c.widths[1] == T.scrollColumnMaximum)
    }

    @Test func unknownWidthUsesIdealWidths() {
        let c = T.columns(ideal: [10, 20], minimum: [5, 5], available: nil)
        #expect(c == T.Columns(widths: [10, 20], scrolls: false))
        #expect(T.columns(ideal: [], minimum: [], available: 300).widths.isEmpty)
    }

    @Test func plainTextDropsMarkup() {
        let inlines = MessageMarkup.parseInlines("`sdk` (also **the default**) [docs](https://e.com)")
        #expect(MessageMarkup.plainText(inlines) == "sdk (also the default) docs")
    }

    @Test func theOwnersTableParsesToThreeRowsOfTwoCells() {
        let md = """
        | Source | Who sends it |
        | --- | --- |
        | `sdk` (also the default when no source is set) | Someone using the app through the Report button |
        | `chat` | A conversation in the team's chat |
        | `agent` | Another agent, with `from_report` |
        """
        guard case .table(let h, _, let rows) = MessageMarkup.parse(md)[0] else { Issue.record("not a table"); return }
        #expect(h.count == 2 && rows.count == 3 && rows.allSatisfy { $0.count == 2 })
    }

    @Test func longestWordShareIsTheLongestWordsPartOfTheText() {
        #expect(MessageMarkup.longestWordShare(MessageMarkup.parseInlines("react-native")) == 1)
        let share = MessageMarkup.longestWordShare(MessageMarkup.parseInlines("aa bbbb cc"))
        #expect(abs(share - 0.4) < 0.001)
        #expect(MessageMarkup.longestWordShare([]) == 0)
    }
}
