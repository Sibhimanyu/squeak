import AppKit
import SwiftUI

/// The brand kit's own files (DESIGN.md §6.1): the duck is never redrawn, recoloured or traced.
/// The packaged app carries them in `Contents/Resources/brand` (scripts/build-app.sh); from a
/// checkout (`swift run`, tests, captures) they are found in the repo's `brand/logo/png/`.
enum BrandAssets {
    /// width : height of the symbol (§6.1).
    static let duckAspect: CGFloat = 1.16056

    static func url(_ name: String) -> URL? {
        if let r = Bundle.main.resourceURL {
            let u = r.appendingPathComponent("brand/\(name)")
            if FileManager.default.fileExists(atPath: u.path) { return u }
        }
        let roots = [URL(fileURLWithPath: FileManager.default.currentDirectoryPath), Bundle.main.executableURL?.deletingLastPathComponent()]
        for case let start? in roots {
            var dir = start
            for _ in 0..<8 {
                for rel in ["brand/logo/png/\(name)"] {
                    let u = dir.appendingPathComponent(rel)
                    if FileManager.default.fileExists(atPath: u.path) { return u }
                }
                dir.deleteLastPathComponent()
            }
        }
        return nil
    }

    /// Full duck at 48 pt and up, compact from 24 to 47 (§6.1); the smallest file that still has
    /// two pixels per point.
    static func duckFile(width: CGFloat) -> String {
        let full = width >= 48
        let sizes = full ? [48, 64, 96, 128, 256, 512, 1024] : [24, 32, 48, 512]
        let want = Int(ceil(width * 2))
        let px = sizes.first { $0 >= want } ?? sizes.last!
        return "squeak-duck-\(full ? "full-color" : "compact")-\(px).png"
    }

    static func image(_ name: String) -> NSImage? { url(name).flatMap { NSImage(contentsOf: $0) } }
}

/// The logo duck, facing right, from the brand files. One per screen, never a row icon (§6.2, §6.3).
struct DuckMark: View {
    /// Width in points. Below 24 the kit has only the silhouette, which is not drawn here.
    var width: CGFloat = 48

    var body: some View {
        if let image = BrandAssets.image(BrandAssets.duckFile(width: max(width, 24))) {
            Image(nsImage: image).resizable().interpolation(.high)
                .aspectRatio(BrandAssets.duckAspect, contentMode: .fit)
                .frame(width: width, height: width / BrandAssets.duckAspect)
                .accessibilityHidden(true)  // decorative (§10)
        }
    }
}

/// The horizontal lockup, duck and name side by side: `ink` file on light, `paper` on dark (§6.1).
struct LogoLockup: View {
    /// Height in points.
    var height: CGFloat = 28
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let name = "squeak-lockup-horizontal-\(scheme == .dark ? "paper" : "ink")-1600.png"
        if let image = BrandAssets.image(name) {
            Image(nsImage: image).resizable().interpolation(.high)
                .aspectRatio(image.size.width / image.size.height, contentMode: .fit)
                .frame(height: height)
                .accessibilityLabel("Squeak")
        } else {
            Text("Squeak").font(Typo.heading).foregroundStyle(Theme.ink)
        }
    }
}
