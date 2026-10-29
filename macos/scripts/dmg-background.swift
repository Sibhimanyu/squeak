// Draw the Squeak DMG window at 1x and 2x: swift dmg-background.swift <out-dir>
// Icon centres are fixed by make-dmg.sh (app at 170,224; Applications at 510,224).
import AppKit

let width: CGFloat = 680, height: CGFloat = 460
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func centered(_ string: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, tint: NSColor) {
    let text = NSAttributedString(string: string, attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: tint,
    ])
    text.draw(at: NSPoint(x: (width - text.size().width) / 2, y: y))
}

func render(scale: CGFloat, to path: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    // Warm paper surface lets Squeak's dark app icon stand out, with a restrained yellow accent.
    let background = NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height))
    NSGradient(starting: color(0xFBF9F1), ending: color(0xF0EEE5))!.draw(in: background, angle: 90)

    // Quiet brand marker and heading.
    let marker = NSBezierPath(roundedRect: NSRect(x: width / 2 - 28, y: height - 42, width: 56, height: 4),
                              xRadius: 2, yRadius: 2)
    color(0xFFDA1A).setFill()
    marker.fill()
    centered("Squeak for Mac", y: height - 83, size: 22, weight: .semibold, tint: color(0x20201E))
    centered("A calmer place for your conversations.", y: height - 106, size: 13, weight: .regular, tint: color(0x686762))

    // Arrow follows the app-to-Applications icon centres set in make-dmg.sh.
    let y = height - 224
    let arrow = NSBezierPath()
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.move(to: NSPoint(x: 264, y: y))
    arrow.line(to: NSPoint(x: 416, y: y))
    arrow.move(to: NSPoint(x: 402, y: y + 12))
    arrow.line(to: NSPoint(x: 418, y: y))
    arrow.line(to: NSPoint(x: 402, y: y - 12))
    color(0xFFDA1A).setStroke()
    arrow.stroke()

    // Practical first-open guidance. Gatekeeper only needs an override if it blocks launch.
    centered("1  Drag Squeak to Applications     ·     2  Open it from Applications", y: 102,
             size: 13, weight: .semibold, tint: color(0x20201E))
    centered("If macOS blocks Squeak, try opening it once; then choose Open Anyway in System Settings → Privacy & Security.",
             y: 73, size: 11, weight: .regular, tint: color(0x686762))

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

render(scale: 1, to: "\(out)/bg.png")
render(scale: 2, to: "\(out)/bg@2x.png")
