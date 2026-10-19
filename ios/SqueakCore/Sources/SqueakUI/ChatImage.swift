#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

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
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 360, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(name)
                .accessibilityHint("Opens the image full screen")
                .fullScreenCover(isPresented: $viewing) { ImageViewer(image: image, title: name) }
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
            case let .image(image): phase = .loaded(image)
            case let .refused(reason): phase = .failed(reason)
            }
        }
    }
}

/// Full screen, black, pinch to zoom and double-tap to fill; Share saves or sends it.
private struct ImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    let image: UIImage
    let title: String
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                ScrollView([.horizontal, .vertical], showsIndicators: false) {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(width: proxy.size.width * scale * pinch, height: proxy.size.height * scale * pinch)
                }
                .gesture(MagnifyGesture()
                    .updating($pinch) { value, state, _ in state = value.magnification }
                    .onEnded { value in scale = min(max(scale * value.magnification, 1), 6) })
                .onTapGesture(count: 2) { scale = scale > 1 ? 1 : 2.5 }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: Image(uiImage: image), preview: SharePreview(title, image: Image(uiImage: image)))
                }
            }
        }
    }
}
#endif
