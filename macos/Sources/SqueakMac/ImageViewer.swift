import AppKit
import SqueakMacCore
import SwiftUI

/// The image tab's body: the picture fit to the window or at a zoom, a checker behind it so transparency reads, and a
/// small bar for zoom in/out, fit and actual size. One view for the whole tab (no per-row measuring).
struct ImageCanvas: View {
    let image: NSImage
    let name: String
    /// nil = fit to the window.
    @State private var zoom: Double?
    @State private var checker = true
    /// The window's fit scale as of the last layout, where a zoom step from "fit" starts.
    @State private var fitScale = 1.0

    private var pixels: (w: Double, h: Double) {
        if let rep = image.representations.first, rep.pixelsWide > 0, rep.pixelsHigh > 0 { return (Double(rep.pixelsWide), Double(rep.pixelsHigh)) }
        return (Double(image.size.width), Double(image.size.height))
    }

    var body: some View {
        VStack(spacing: 0) {
            bar
            Rectangle().fill(Theme.line).frame(height: 1)
            GeometryReader { box in
                let fit = ImageZoom.fit(image: pixels, box: (Double(box.size.width) - 2 * Space.l, Double(box.size.height) - 2 * Space.l))
                let scale = zoom ?? fit
                let size = CGSize(width: pixels.w * scale, height: pixels.h * scale)
                ScrollView([.horizontal, .vertical]) {
                    ZStack {
                        if checker { Checkerboard().frame(width: size.width, height: size.height) }
                        Image(nsImage: image).resizable().interpolation(scale >= 2 ? .none : .high)
                            .frame(width: size.width, height: size.height)
                    }
                    .overlay(Rectangle().strokeBorder(Theme.line))
                    .padding(Space.l)
                    .frame(minWidth: box.size.width, minHeight: box.size.height)
                }
                .overlay(alignment: .bottomTrailing) {
                    Text(verbatim: "\(Int((scale * 100).rounded()))%").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.surfaceRaised, in: Capsule()).padding(Space.m)
                }
                .onChange(of: fit, initial: true) { _, new in fitScale = new }
            }
        }
        .accessibilityLabel(name)
    }

    private var bar: some View {
        HStack(spacing: Space.s) {
            Text(verbatim: "\(Int(pixels.w)) × \(Int(pixels.h))").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            Spacer(minLength: Space.s)
            Toggle(isOn: $checker) { Text("Transparency grid") }.toggleStyle(.checkbox).font(Typo.meta)
            Button("Fit") { zoom = nil }.buttonStyle(SecondaryButtonStyle()).help("Fit to the window")
            Button("100%") { zoom = 1 }.buttonStyle(SecondaryButtonStyle()).help("Actual size")
            Button { zoom = ImageZoom.zoomedOut(zoom ?? fitScale) } label: { Image(systemName: "minus").frame(width: 24, height: 24) }
                .buttonStyle(SecondaryButtonStyle()).help("Zoom out").accessibilityLabel("Zoom out")
            Button { zoom = ImageZoom.zoomedIn(zoom ?? fitScale) } label: { Image(systemName: "plus").frame(width: 24, height: 24) }
                .buttonStyle(SecondaryButtonStyle()).help("Zoom in").accessibilityLabel("Zoom in")
        }
        .padding(.horizontal, Space.m).frame(height: 36)
    }
}

/// A light/dark checker behind a transparent image: drawn once as a Canvas, not as views.
private struct Checkerboard: View {
    var body: some View {
        Canvas { ctx, size in
            let cell: CGFloat = 10
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.92)))
            var y: CGFloat = 0, row = 0
            while y < size.height {
                var x: CGFloat = row % 2 == 0 ? cell : 0
                while x < size.width {
                    ctx.fill(Path(CGRect(x: x, y: y, width: cell, height: cell)), with: .color(Color(white: 0.8)))
                    x += cell * 2
                }
                y += cell; row += 1
            }
        }
    }
}
