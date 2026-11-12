import AppKit
import SwiftUI
import XCTest

@testable import SqueakMacCore

/// Offscreen (never shown) measurement of the transcript's short-chat rule: ScrollView + safeAreaInset dock.
@MainActor
final class ShortChatLayoutMeasureTests: XCTestCase {
    final class Probe: ObservableObject {
        @Published var viewport: CGFloat = 0
        @Published var dock: CGFloat = 0
        var contentBottom: CGFloat = 0
        var contentHeight: CGFloat = 0
        var dockTop: CGFloat = 0
    }

    struct Harness: View {
        @ObservedObject var probe: Probe
        let subtractDock: Bool
        var body: some View {
            let min = subtractDock ? max(0, probe.viewport - probe.dock) : probe.viewport
            ScrollView {
                Text("hello").frame(maxWidth: .infinity, alignment: .leading)
                    .frame(maxWidth: .infinity, minHeight: min.rounded(), alignment: .bottom)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("host")) } action: {
                        probe.contentBottom = $0.maxY; probe.contentHeight = $0.height
                    }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { probe.viewport = $0 }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.red.frame(height: 100)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { probe.dock = $0 }
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("host")).minY } action: { probe.dockTop = $0 }
            }
            .coordinateSpace(name: "host")
        }
    }

    private func run(subtractDock: Bool) -> Probe {
        let probe = Probe()
        let host = NSHostingView(rootView: Harness(probe: probe, subtractDock: subtractDock))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 600)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host   // never ordered front
        for _ in 0..<6 {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return probe
    }

    func testViewportExcludesDockSoSubtractingItTwiceLeavesAGap() {
        let sub = run(subtractDock: true)
        XCTAssertEqual(sub.viewport, 500, "the ScrollView's measured height already excludes the 100 pt dock inset")
        XCTAssertEqual(sub.dockTop - sub.contentBottom, 100, "subtracting the dock again leaves a dock-height gap")
    }

    func testMinHeightIsViewportSoContentEndsAtDockTop() {
        let probe = Probe()
        let host = NSHostingView(rootView: Harness(probe: probe, subtractDock: false))
        host.frame = NSRect(x: 0, y: 0, width: 400, height: 600)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host
        for _ in 0..<6 { host.layoutSubtreeIfNeeded(); RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertEqual(probe.contentBottom, probe.dockTop, accuracy: 0.5)
        XCTAssertEqual(probe.contentHeight, probe.viewport, accuracy: 0.5, "no extra scroll range")
        XCTAssertEqual(TranscriptMinHeight.value(viewport: 500.4), 500)
        XCTAssertEqual(TranscriptMinHeight.value(viewport: -3), 0)
    }
}
