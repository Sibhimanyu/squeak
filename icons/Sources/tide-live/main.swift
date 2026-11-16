// Live preview of TideGlyph: `swift run -c release tide-live`. One normal window; never activates or takes focus.
import AppKit
import SwiftUI
import SqueakIcons

@MainActor final class Model: ObservableObject {
    @Published var tuning = TideMotion.Tuning()
    @Published var sidebarHeight = 12.0
    func reset() { tuning = TideMotion.Tuning(); sidebarHeight = 12 }
    var source: String { "\(tuning.swiftSource)  // sidebar glyph height: \(String(format: "%.3g", sidebarHeight))" }
    func copy() {
        print(source); fflush(stdout)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(source, forType: .string)
    }
}

func hex(_ v: UInt32) -> Color { Color(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255) }

/// DESIGN.md §3.2 / §3.3 Mac tokens.
struct Palette {
    let sidebar, raised, ink, muted, working, add, remove: Color
    static let dark = Palette(sidebar: hex(0x1C1915), raised: hex(0x26221E), ink: hex(0xECE7E2), muted: hex(0xAFAAA5), working: hex(0x4C8DFF), add: hex(0x4ADE80), remove: hex(0xF87272))
    static let light = Palette(sidebar: hex(0xFCF7F1), raised: .white, ink: hex(0x292622), muted: hex(0x67625E), working: hex(0x1D4ED8), add: hex(0x16A249), remove: hex(0xDC2828))
}

struct Showcase: View {
    let p: Palette; let title: String; @ObservedObject var m: Model
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(p.muted)
            HStack(spacing: 14) {   // sidebar chat row, as the Mac: the mark slot (20 wide, glyph 11.5 right-aligned) then the title
                TideGlyph(color: p.working, height: m.sidebarHeight, grid: .mark, tuning: m.tuning)
                    .frame(width: 20, height: 16, alignment: .trailing)
                Text("Hong Kong").font(.system(size: 14)).foregroundStyle(p.ink).lineLimit(1)
                Spacer(minLength: 0)
                Group { Text("+25k").foregroundStyle(p.add); Text("\u{2212}3.8k").foregroundStyle(p.remove) }
                    .font(.system(size: 11, design: .monospaced))
            }.padding(.horizontal, 10).frame(width: 260, height: 36)
                .background(p.raised, in: RoundedRectangle(cornerRadius: 7))
            HStack(spacing: 8) {   // pond header: tile, title, the rollup mark right after the title
                Text("G").font(.system(size: 11, weight: .bold)).foregroundStyle(p.ink).frame(width: 20, height: 20)
                    .background(p.raised, in: RoundedRectangle(cornerRadius: 5))
                Text("greenroom").font(.system(size: 14, weight: .semibold)).foregroundStyle(p.ink)
                TideGlyph(color: p.working, height: 11.5, grid: .mark, tuning: m.tuning)
                    .frame(width: 20, height: 16, alignment: .leading)
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).frame(width: 260, height: 38)
            VStack(alignment: .leading, spacing: 6) {   // pond card
                Text("greenroom").font(.system(size: 13, weight: .medium)).foregroundStyle(p.ink)
                TideGlyph(color: p.working, height: 28, tuning: m.tuning)
            }.padding(12).frame(width: 260, alignment: .leading).background(p.raised, in: RoundedRectangle(cornerRadius: 9))
            HStack(spacing: 10) {   // x4 zoom
                TideGlyph(color: p.working, height: 12 * 4, grid: .mark, tuning: m.tuning)
                Text("\u{00D7}4").font(.caption).foregroundStyle(p.muted)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(p.sidebar)
    }
}

struct Slider1: View {
    let label: String; @Binding var value: Double; let range: ClosedRange<Double>
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack { Text(label); Spacer(); Text(String(format: "%.2f", value)).monospacedDigit().foregroundStyle(.secondary) }.font(.caption)
            Slider(value: $value, in: range).controlSize(.small)
        }
    }
}

struct Controls: View {
    @ObservedObject var m: Model
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Slider1(label: "Overall speed", value: $m.tuning.speed, range: 0.1...2)
            Slider1(label: "Pace drift", value: $m.tuning.paceDrift, range: 0...2)
            Slider1(label: "Choppiness low", value: $m.tuning.choppinessLow, range: 0...1)
            Slider1(label: "Choppiness high", value: $m.tuning.choppinessHigh, range: 0...1)
            Slider1(label: "Sparkle rate", value: $m.tuning.sparkle, range: 0...3)
            Slider1(label: "Vignette strength", value: $m.tuning.vignette, range: 0...1.5)
            Slider1(label: "Smoothness (s)", value: $m.tuning.smoothness, range: 0...0.8)
            Slider1(label: "Sidebar glyph height", value: $m.sidebarHeight, range: 6...24)
            VStack(alignment: .leading, spacing: 2) {
                Text("Frame rate").font(.caption)
                Picker("", selection: $m.tuning.frameRate) { Text("15").tag(15); Text("30").tag(30); Text("60").tag(60) }
                    .pickerStyle(.segmented).labelsHidden()
            }
            HStack { Button("Copy values") { m.copy() }; Button("Reset") { m.reset() } }
            Spacer()
        }.padding(14).frame(width: 230)
    }
}

struct Root: View {
    @ObservedObject var m: Model
    var body: some View {
        HStack(spacing: 0) {
            ScrollView { VStack(spacing: 0) {
                Showcase(p: .dark, title: "DARK", m: m)
                Showcase(p: .light, title: "LIGHT", m: m)
            } }
            Divider()
            Controls(m: m).background(.background)
        }.frame(minWidth: 720, minHeight: 520)
            .environment(\.scenePhase, .active)  // an NSHostingView outside a Scene never reports .active
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let model = Model()
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 520), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "Tide glyph preview"
window.contentView = NSHostingView(rootView: Root(m: model))
window.collectionBehavior = [.moveToActiveSpace, .fullScreenNone]
if let f = NSScreen.main?.visibleFrame { window.setFrameOrigin(NSPoint(x: f.midX - 360, y: f.midY - 260)) } else { window.center() }
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
final class Delegate: NSObject, NSApplicationDelegate { func applicationShouldTerminateAfterLastWindowClosed(_ a: NSApplication) -> Bool { true } }
let delegate = Delegate()
app.delegate = delegate
app.run()
