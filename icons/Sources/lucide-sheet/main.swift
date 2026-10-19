// Contact sheet of every icon at 16 and 20pt: `swift run lucide-sheet out.png`.
#if canImport(AppKit)
import AppKit
import SwiftUI
import SqueakIcons

@MainActor
func run() {
    let out = CommandLine.arguments.dropFirst().first ?? "lucide-sheet.png"
    let cols = 8
    let names = LucideName.allCases
    let sheet = VStack(alignment: .leading, spacing: 14) {
        ForEach(0..<((names.count + cols - 1) / cols), id: \.self) { row in
            HStack(alignment: .top, spacing: 14) {
                ForEach(names.dropFirst(row * cols).prefix(cols), id: \.self) { n in
                    VStack(spacing: 6) {
                        HStack(spacing: 8) {
                            Lucide(n, size: 16, color: Color.black)
                            Lucide(n, size: 20, color: Color.black)
                            Lucide(n, size: 72, color: Color.black)
                        }
                        Text(n.rawValue).font(.system(size: 9, design: .monospaced)).foregroundStyle(.gray)
                    }
                    .frame(width: 140)
                }
            }
        }
    }
    .padding(20)
    .background(Color.white)
    let r = ImageRenderer(content: sheet)
    r.scale = 2
    guard let cg = r.cgImage,
        let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
    else { fputs("render failed\n", stderr); exit(1) }
    try! png.write(to: URL(fileURLWithPath: out))
    print("wrote \(out)")
}
MainActor.assumeIsolated { run() }
#else
print("lucide-sheet needs macOS")
#endif
