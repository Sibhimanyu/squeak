#if os(iOS)
import SwiftUI
import UIKit

/// Full screen, like Photos: pinch to zoom (to 4x), double-tap to zoom at the tap, pan when zoomed,
/// swipe down to close (the background fades with it), swipe sideways between several pictures.
/// Share carries Save Image, Copy and AirDrop.
struct ImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    let images: [UIImage]
    let title: String
    @State private var index: Int
    @State private var drag: CGFloat = 0

    init(images: [UIImage], index: Int = 0, title: String) {
        self.images = images; self.title = title; _index = State(initialValue: index)
    }

    private var fade: Double { 1 - min(Double(abs(drag)) / 400, 0.75) }

    var body: some View {
        ZStack {
            Color.black.opacity(fade).ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(images.indices, id: \.self) { i in
                    ZoomableImage(image: images[i]) { drag = $0 } onRelease: { translation, velocity in
                        if abs(translation) > 120 || abs(velocity) > 900 { dismiss() } else { withAnimation(.spring(duration: 0.3)) { drag = 0 } }
                    }
                    .ignoresSafeArea()
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Color.black)
            .ignoresSafeArea()
            .offset(y: drag)
        }
        .overlay(alignment: .top) {
            HStack {
                Button { dismiss() } label: { chrome("xmark") }.accessibilityLabel("Close")
                Spacer()
                if images.indices.contains(index) {
                    ShareLink(item: Image(uiImage: images[index]), preview: SharePreview(title, image: Image(uiImage: images[index]))) { chrome("square.and.arrow.up") }
                        .accessibilityLabel("Share")
                }
            }
            .padding(.horizontal, 16).padding(.top, 8)
            .opacity(fade)
        }
        .preferredColorScheme(.dark)
        .presentationBackground(.clear)
    }

    private func chrome(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
            .frame(width: 36, height: 36).background(.ultraThinMaterial, in: Circle())
    }
}

/// One picture in a UIScrollView, which does zoom bounds and panning properly.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let onDrag: (CGFloat) -> Void
    let onRelease: (CGFloat, CGFloat) -> Void

    func makeUIView(context: Context) -> ZoomScrollView {
        let view = ZoomScrollView(image: image)
        view.onDrag = onDrag; view.onRelease = onRelease
        return view
    }
    func updateUIView(_ view: ZoomScrollView, context: Context) { view.onDrag = onDrag; view.onRelease = onRelease }
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    static let maxZoom: CGFloat = 4
    let imageView: UIImageView
    var onDrag: (CGFloat) -> Void = { _ in }
    var onRelease: (CGFloat, CGFloat) -> Void = { _, _ in }
    private var laidOutFor: CGSize = .zero

    init(image: UIImage) {
        imageView = UIImageView(image: image)
        super.init(frame: .zero)
        delegate = self
        backgroundColor = .black
        showsHorizontalScrollIndicator = false; showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        minimumZoomScale = 1; maximumZoomScale = Self.maxZoom
        bouncesZoom = true
        addSubview(imageView)
        let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        double.numberOfTapsRequired = 2
        addGestureRecognizer(double)
        let dismissPan = UIPanGestureRecognizer(target: self, action: #selector(dismissPanned(_:)))
        dismissPan.delegate = self
        addGestureRecognizer(dismissPan)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The picture fitted to the screen at zoom 1, centred; re-fitted when the screen turns.
    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, let size = imageView.image?.size, size.width > 0, size.height > 0 else { return }
        if laidOutFor != bounds.size {
            laidOutFor = bounds.size
            zoomScale = 1
            let fit = min(bounds.width / size.width, bounds.height / size.height)
            imageView.frame = CGRect(origin: .zero, size: CGSize(width: size.width * fit, height: size.height * fit))
            contentSize = imageView.frame.size
        }
        var frame = imageView.frame
        frame.origin.x = max(0, (bounds.width - frame.width) / 2)
        frame.origin.y = max(0, (bounds.height - frame.height) / 2)
        imageView.frame = frame
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { setNeedsLayout() }

    @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 { setZoomScale(minimumZoomScale, animated: true); return }
        let target: CGFloat = 2.5
        let point = tap.location(in: imageView)
        let size = CGSize(width: bounds.width / target, height: bounds.height / target)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }

    @objc private func dismissPanned(_ pan: UIPanGestureRecognizer) {
        let dy = pan.translation(in: self).y
        switch pan.state {
        case .changed: onDrag(dy)
        case .ended, .cancelled: onRelease(dy, pan.velocity(in: self).y)
        default: break
        }
    }

    /// Only a mostly-vertical drag while the picture is not zoomed closes it; zoomed, a drag pans.
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer, pan.delegate === self else {
            return super.gestureRecognizerShouldBegin(gestureRecognizer)
        }
        let v = pan.velocity(in: self)
        return zoomScale <= minimumZoomScale + 0.01 && abs(v.y) > abs(v.x)
    }
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
#endif
