import AppKit
import XCTest

@testable import SqueakMacCore

@MainActor
final class CodeViewSupportTests: XCTestCase {
    func testGutterFillNeverLeavesTheGutter() {
        let gutter = NSRect(x: 0, y: 0, width: 44, height: 260)
        XCTAssertEqual(CodeViewSupport.gutterFill(dirty: NSRect(x: 0, y: 0, width: 500, height: 260), bounds: gutter), gutter)
        XCTAssertEqual(CodeViewSupport.gutterFill(dirty: NSRect(x: 0, y: -40, width: 500, height: 300), bounds: gutter), gutter)
    }

    func testTextSetLaterKeepsTheForeground() {
        let tv = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
        tv.isRichText = false
        let ink = NSColor(srgbRed: 0.92, green: 0.91, blue: 0.9, alpha: 1)
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        CodeViewSupport.style(tv, font: font, color: ink)
        tv.string = "# Title\nhello\n"
        CodeViewSupport.style(tv, font: font, color: ink)
        let attrs = tv.textStorage!.attributes(at: 0, effectiveRange: nil)
        XCTAssertEqual(attrs[.foregroundColor] as? NSColor, ink)
        XCTAssertEqual(tv.typingAttributes[.foregroundColor] as? NSColor, ink)
    }
}
