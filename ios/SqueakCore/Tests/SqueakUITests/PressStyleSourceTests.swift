import Foundation
import XCTest

/// Every tap reacts on the touch: the shared `PressStyle` is the only button style the UI sources may use for a
/// tappable, so `.buttonStyle(.plain)` (which gives no press feedback) must not come back.
final class PressStyleSourceTests: XCTestCase {
    func testNoPlainButtonStyleInSqueakUI() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/SqueakUI")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var checked = 0
        var offenders: [String] = []
        for case let url as URL in files where url.pathExtension == "swift" {
            checked += 1
            let text = try String(contentsOf: url, encoding: .utf8)
            for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()
            where line.contains(".buttonStyle(.plain)") {
                offenders.append("\(url.lastPathComponent):\(i + 1)")
            }
        }
        XCTAssertGreaterThan(checked, 20, "found no UI sources at \(root.path)")
        XCTAssertTrue(offenders.isEmpty, "use .buttonStyle(.press), not .plain: \(offenders.joined(separator: ", "))")
    }
}
