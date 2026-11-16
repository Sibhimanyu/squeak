// Headless preview of TideGlyph: `swift run tide-preview [outDir]`. Renders PNGs, GIFs and preview.html; opens no window.
#if canImport(AppKit)
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import SqueakIcons

struct Palette {
    let bg: Color, ink: Color, working: Color, waiting: Color, failed: Color, unread: Color
    static let dark = Palette(bg: hex(0x1A1514), ink: hex(0xF2EEEA), working: hex(0x4C8DFF), waiting: hex(0xE0A030),
                              failed: hex(0xF87171), unread: hex(0xFFDA1A))
    static let light = Palette(bg: hex(0xFFFFFF), ink: hex(0x1F1A17), working: hex(0x1D4ED8), waiting: hex(0xA16207),
                               failed: hex(0xDC2626), unread: hex(0x8A5A00))
}
func hex(_ v: Int) -> Color { Color(red: Double(v >> 16 & 255) / 255, green: Double(v >> 8 & 255) / 255, blue: Double(v & 255) / 255) }

@MainActor func image<V: View>(_ v: V, scale: CGFloat) -> CGImage {
    let r = ImageRenderer(content: v); r.scale = scale
    return r.cgImage!
}
@MainActor func writePNG(_ img: CGImage, _ path: String) {
    try! NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}
func label(_ s: String, _ p: Palette) -> some View { Text(s).font(.system(size: 9, design: .monospaced)).foregroundStyle(p.ink.opacity(0.7)) }

let pad: CGFloat = 6, gifGap: CGFloat = 8
@MainActor func gif(_ path: String, height: CGFloat, p: Palette) {
    let frames = 450  // 30 s, so the pace and character drift show
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.gif.identifier as CFString, frames, nil)!
    CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    for i in 0..<frames {
        let v = HStack(spacing: gifGap) {
            ForEach([11, 222, 3333], id: \.self) { sd in TideFrame(color: p.working, height: height, time: Double(i) / 15, seed: UInt64(sd)) }
        }.padding(pad).background(p.bg)
        CGImageDestinationAddImage(dest, image(v, scale: 6),
            [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 1.0 / 15]] as CFDictionary)
    }
    precondition(CGImageDestinationFinalize(dest))
    print("wrote \(path)")
}

@MainActor func run() {
    let out = CommandLine.arguments.dropFirst().first
        ?? "/Users/sibhi-zstch1643/conductor/workspaces/squeak/ushuaia/.context/tide"
    try! FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    let d = Palette.dark, markH: CGFloat = 14, largeH: CGFloat = 24

    // 1. strips: 24 consecutive working frames at 1/15 s.
    func strip(_ height: CGFloat, _ file: String, scale: CGFloat) {
        let v = HStack(spacing: 12) {
            ForEach(0..<24, id: \.self) { i in
                let t = 2.0 + Double(i) / 15
                VStack(spacing: 4) {
                    TideFrame(color: d.working, height: height, time: t, seed: 11)
                    label(String(format: "%.2f", t), d)
                }
            }
        }.padding(12).background(d.bg)
        writePNG(image(v, scale: scale), out + file)
    }
    strip(markH, "/strip-working.png", scale: 3)
    strip(largeH, "/strip-large.png", scale: 2)

    // 1b. zoom: 8 frames 0.15 s apart at large height, x5, to read the flow.
    let zoom = VStack(alignment: .leading, spacing: 8) {
        ForEach(0..<4, id: \.self) { rowIndex in
            HStack(spacing: 24) {
                ForEach(0..<2, id: \.self) { k in
                    let t = 2.0 + Double(rowIndex * 2 + k) * 0.15
                    VStack(spacing: 2) { TideFrame(color: d.working, height: largeH, time: t); label(String(format: "%.2f", t), d) }
                }
            }
        }
    }.padding(12).background(d.bg)
    writePNG(image(zoom, scale: 5), out + "/strip-zoom.png")

    // 1c. real size: retina (x2) render beside sidebar text, dark and light, to judge 1x legibility.
    func real(_ p: Palette) -> some View {
        HStack(spacing: 30) {
            HStack(spacing: 6) {
                TideFrame(color: p.working, height: markH, time: 2.4)
                Text("Hong Kong").font(.system(size: 13)).foregroundStyle(p.ink)
                Text("+25k \u{2212}3.8k").font(.system(size: 11)).foregroundStyle(p.ink.opacity(0.6))
            }
            TideFrame(color: p.working, height: 10, time: 2.4)
            TideFrame(color: p.working, height: largeH, time: 2.4)
        }.padding(10).background(p.bg)
    }
    writePNG(image(VStack(spacing: 0) { real(.dark); real(.light) }, scale: 2), out + "/real-size.png")

    // 1d. sidebar: the pond header row and a chat row at real 2x scale on the dark sidebar (#1C1915, DESIGN.md), with the
    // glyph sizes the Mac call sites use (WorkingGlyph: pond mark 14 pt right-aligned in a 24 pt slot, chat mark 13 pt in 20 pt).
    func sidebar(_ t: Double) -> some View {
        let side = hex(0x1C1915)
        let pond = HStack(spacing: 10) {
            Text("G").font(.system(size: 15, weight: .bold)).foregroundStyle(d.ink).frame(width: 20, height: 20)
                .padding(3).background(hex(0x2F5D3A), in: RoundedRectangle(cornerRadius: 7)).padding(-3)
            Text("greenroom").font(.system(size: 14, weight: .semibold)).foregroundStyle(d.ink).lineLimit(1)
            TideFrame(color: d.working, height: 14, grid: .mark, time: t, seed: 11).frame(width: 24, height: 12, alignment: .trailing).padding(.leading, 18)
            Spacer(minLength: 0)
            Text("\u{2304}").font(.system(size: 12)).foregroundStyle(d.ink.opacity(0.5))
            Text("+").font(.system(size: 16)).foregroundStyle(d.ink.opacity(0.5))
        }.padding(.leading, 10).padding(.trailing, 12).frame(width: 280, height: 38, alignment: .leading)
        let chat = HStack(spacing: 10) {
            TideFrame(color: d.working, height: 11.5, grid: .mark, time: t, seed: 222).frame(width: 20, height: 16, alignment: .trailing)
            Text("Hong Kong").font(.system(size: 14)).foregroundStyle(d.ink).lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                Text("+26k").foregroundStyle(hex(0x4CB782)); Text("\u{2212}3.8k").foregroundStyle(hex(0xF87171))
            }.font(.system(size: 11, design: .monospaced))
        }.padding(.leading, 22).padding(.trailing, 10).frame(width: 280, height: 36, alignment: .leading)
        return VStack(spacing: 0) { pond; chat }.padding(.vertical, 8).background(side)
    }
    writePNG(image(sidebar(2.4), scale: 2), out + "/sidebar.png")
    writePNG(image(VStack(spacing: 0) { ForEach(0..<3, id: \.self) { sidebar(2 + Double($0) * 4.3) } }, scale: 2), out + "/sidebar-3.png")

    // 2. marks: the glyph (still frame) and each StatusMark, dark and light, x4.
    func row(_ p: Palette) -> some View {
        let sizes: [CGFloat] = [12, 20, 32]
        func cell<V: View>(_ name: String, @ViewBuilder _ make: @escaping (CGFloat) -> V) -> some View {
            VStack(spacing: 6) {
                HStack(alignment: .center, spacing: 10) { ForEach(sizes, id: \.self) { make($0) } }
                label(name, p)
            }
        }
        return HStack(alignment: .top, spacing: 22) {
            cell("tide (still)") { TideFrame(color: p.working, height: $0, time: nil) }
            cell("waiting 3") { StatusMark(kind: .waiting(count: 3), color: p.waiting, size: $0) }
            cell("waiting") { StatusMark(kind: .waiting(count: nil), color: p.waiting, size: $0) }
            cell("failed") { StatusMark(kind: .failed, color: p.failed, size: $0) }
            cell("unread") { StatusMark(kind: .unread, color: p.unread, size: $0) }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(p.bg)
    }
    writePNG(image(VStack(spacing: 0) { row(.dark); row(.light) }, scale: 4), out + "/marks.png")

    // 3. GIFs (dark and light) at mark and large heights, x6, 15 fps, 6 s, looping.
    for (name, h) in [("mark", markH), ("large", largeH)] {
        gif(out + "/working-\(name)-dark.gif", height: h, p: .dark)
        gif(out + "/working-\(name)-light.gif", height: h, p: .light)
    }
    try? FileManager.default.removeItem(atPath: out + "/working.gif")
    try? FileManager.default.copyItem(atPath: out + "/working-large-dark.gif", toPath: out + "/working.gif")

    // 4. preview.html: 1x real size and x6, on dark and light, beside sample sidebar text.
    func dims(_ h: CGFloat) -> (CGFloat, CGFloat) { (3 * TideGlyph.Grid.preset(forHeight: h).width(height: h) + 2 * gifGap + 2 * pad, h + 2 * pad) }
    func block(_ mode: String, bg: String, ink: String, muted: String) -> String {
        let (mw, mh) = dims(markH), (lw, lh) = dims(largeH)
        func img(_ n: String, _ w: CGFloat, _ h: CGFloat, _ k: CGFloat = 1) -> String {
            "<img src='working-\(n)-\(mode).gif' width='\(w * k)' height='\(h * k)' style='image-rendering:auto'>"
        }
        return """
        <section style='background:\(bg);color:\(ink);padding:20px;font:13px -apple-system,sans-serif'>
          <h3 style='margin:0 0 12px;font-weight:600'>\(mode)</h3>
          <div style='display:flex;align-items:center;gap:8px;margin-bottom:10px'>\(img("mark", mw, mh))
            <span>Hong Kong</span><span style='margin-left:24px;color:\(muted)'>+25k  \u{2212}3.8k</span></div>
          <div style='display:flex;align-items:center;gap:8px;margin-bottom:16px'>\(img("large", lw, lh))
            <span>Pond card, large at 1x</span></div>
          <div style='display:flex;gap:24px;align-items:flex-start'>\(img("mark", mw, mh, 6))\(img("large", lw, lh, 6))</div>
        </section>
        """
    }
    let html = "<!doctype html><meta charset=utf-8><title>TideGlyph</title><body style='margin:0'>"
        + "<p style='margin:0;padding:12px 20px;background:#333;color:#eee;font:12px -apple-system,sans-serif'>Each GIF is only a recording (three seeds side by side, 10 s, looping). The real glyph is computed every frame from noise and a per-view random seed: it has no period and never repeats, and two glyphs never match.</p>"
        + block("dark", bg: "#1A1514", ink: "#F2EEEA", muted: "#AAA39D")
        + block("light", bg: "#FFFFFF", ink: "#1F1A17", muted: "#5A534E")
    try! html.write(toFile: out + "/preview.html", atomically: true, encoding: .utf8)
    print("wrote \(out)/preview.html")
}
MainActor.assumeIsolated { run() }
#else
print("tide-preview needs AppKit")
#endif
