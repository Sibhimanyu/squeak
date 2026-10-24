#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Gives its one child the picture's own shape: as wide as the space allows (never past the picture's own
/// size), as tall as that makes it up to `maxHeight`. The container is the picture, with no padding around it.
private struct ImageFitLayout: Layout {
    let natural: CGSize
    let maxHeight: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? natural.width
        return ImageSizing.fit(natural: natural, maxWidth: width, maxHeight: maxHeight)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

/// An image the agent put in its answer (`![alt](/…/shot.png)`), which lives on the Mac. It loads on
/// a tap, never by itself: nothing leaves the Mac until you ask. Loaded, a tap opens it full screen.
struct ChatImage: View {
    @Environment(AppModel.self) private var model
    let alt: String
    let source: String
    let session: PhoneSnapshot.Session

    private enum Phase { case idle, loading, loaded(UIImage), failed(String) }
    @State private var phase: Phase = .idle
    @State private var viewing = false

    private var name: String { alt.isEmpty ? (source as NSString).lastPathComponent : alt }

    var body: some View {
        Group {
            switch phase {
            case let .loaded(image):
                Button { viewing = true } label: {
                    ImageFitLayout(natural: image.size, maxHeight: UIScreen.main.bounds.height * ImageSizing.maxHeightFraction) {
                        Image(uiImage: image).resizable()
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contextMenu {
                    Button { UIPasteboard.general.image = image } label: { Label("Copy", systemImage: "doc.on.doc") }
                    ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image))) {
                        Label("Share or Save…", systemImage: "square.and.arrow.up")
                    }
                } preview: {
                    Image(uiImage: image).resizable().scaledToFit()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(name)
                .accessibilityHint("Opens the image full screen")
                .fullScreenCover(isPresented: $viewing) { ImageViewer(images: [image], title: name) }
            default:
                Button { load() } label: { placeholder }
                    .buttonStyle(.plain)
                    .disabled(isLoading)
                    .accessibilityLabel("Image: \(name)")
                    .accessibilityHint("Loads it from your Mac")
            }
        }
        .padding(.vertical, 4)
        // `-squeak-image-open`: load it at once, for screenshots of the demo.
        .onAppear { if ProcessInfo.processInfo.arguments.contains("-squeak-image-open"), case .idle = phase { load() } }
    }

    private var isLoading: Bool { if case .loading = phase { true } else { false } }

    private var placeholder: some View {
        HStack(spacing: 10) {
            if isLoading { ProgressView().frame(width: 18) } else { Lucide(.eye, size: 18, color: Theme.muted).accessibilityHidden(true) }
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                if case let .failed(reason) = phase {
                    Text(reason).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
                } else {
                    Text(isLoading ? "Loading from your Mac…" : "Image · tap to show").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).frame(minHeight: 56)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .contentShape(RoundedRectangle(cornerRadius: 12))
    }

    private func load() {
        phase = .loading
        Task {
            switch await model.loadImage(session, source: source) {
            case let .image(image):
                phase = .loaded(image)
                // `-squeak-image-viewer`: open the first picture at once, for screenshots of the demo.
                if source.contains("-portrait"), ProcessInfo.processInfo.arguments.contains("-squeak-image-viewer") { viewing = true }
            case let .refused(reason): phase = .failed(reason)
            }
        }
    }
}
#endif
