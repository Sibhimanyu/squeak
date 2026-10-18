// Draws the DMG window background at 1x and 2x: swift dmg-background.swift <out-dir>
// Icon centres are fixed by make-dmg.sh (app at 160,198; Applications at 460,198).
import AppKit

let width: CGFloat = 620, height: CGFloat = 400
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func render(scale: CGFloat, to path: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    color(0x18181B).setFill()                       // DESIGN.md surface (dark)
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    // Arrow from the app to Applications. Finder's y runs down; AppKit's up.
    let y = height - 198
    let arrow = NSBezierPath()
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.move(to: NSPoint(x: 250, y: y))
    arrow.line(to: NSPoint(x: 370, y: y))
    arrow.move(to: NSPoint(x: 356, y: y + 12))
    arrow.line(to: NSPoint(x: 372, y: y))
    arrow.line(to: NSPoint(x: 356, y: y - 12))
    color(0xFCD02C).setStroke()                      // duck
    arrow.stroke()

    let title = NSAttributedString(string: "Drag Squeak to Applications", attributes: [
        .font: NSFont.systemFont(ofSize: 18, weight: .semibold), .foregroundColor: color(0xF4F4F5),
    ])
    let sub = NSAttributedString(string: "Then open it from Applications: right-click › Open the first time.", attributes: [
        .font: NSFont.systemFont(ofSize: 12), .foregroundColor: color(0xA1A1AA),
    ])
    title.draw(at: NSPoint(x: (width - title.size().width) / 2, y: height - 70))
    sub.draw(at: NSPoint(x: (width - sub.size().width) / 2, y: 46))

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

render(scale: 1, to: "\(out)/bg.png")
render(scale: 2, to: "\(out)/bg@2x.png")
