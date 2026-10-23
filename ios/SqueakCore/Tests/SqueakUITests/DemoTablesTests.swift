#if os(iOS)
import SqueakMarkup
import XCTest
@testable import SqueakUI

final class DemoTablesTests: XCTestCase {
    private func tables(_ markdown: String) -> [(header: Int, rows: Int)] {
        MessageMarkup.parse(markdown).compactMap { block in
            if case .table(let header, _, let rows) = block { return (header.count, rows.count) }
            return nil
        }
    }

    func testDemoHasTheWrappedTableAndTheWideOne() {
        let found = tables(DemoData.tablesMessage)
        XCTAssertEqual(found.count, 2)
        XCTAssertEqual(found[0].header, 2)
        XCTAssertEqual(found[0].rows, 3)
        XCTAssertEqual(found[1].header, 4)
        XCTAssertEqual(found[1].rows, 4)
    }

    func testDemoRichMessageTableIsUnchanged() {
        XCTAssertEqual(tables(DemoData.richMessage).count, 1)
    }
}
#endif
