#if os(iOS)
import SqueakIcons
import SwiftUI
import UIKit

/// The links in a message, whole and in order, for the "Copy link" rows. Found with the system's own link
/// detector, so a bare `github.com/x/y` counts and trailing punctuation does not.
enum MessageLinks {
    static func urls(in text: String, limit: Int = 6) -> [String] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let whole = NSRange(text.startIndex..., in: text)
        var seen = Set<String>()
        var out: [String] = []
        detector.enumerateMatches(in: text, options: [], range: whole) { match, _, stop in
            guard let range = match.flatMap({ Range($0.range, in: text) }) else { return }
            let found = String(text[range])
            // Mail and phone numbers are links to the detector, not to a person copying a URL.
            guard found.lowercased().hasPrefix("http") || found.contains("."), !found.contains("@") else { return }
            if seen.insert(found).inserted { out.append(found) }
            if out.count >= limit { stop.pointee = true }
        }
        return out
    }

    static func host(_ url: String) -> String {
        let bare = url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
        return String(bare.prefix { $0 != "/" && $0 != "?" && $0 != "#" })
    }
}

/// A message in a screen of its own, as plain selectable text. Selecting inside the chat is at the mercy of a
/// scroll view that moves and rows that are laid out again as the work streams; here nothing moves, the text is
/// the one the message had when this opened, and the system's own selection (handles, magnifier, Copy) applies.
/// Links are listed on top, each one tap to copy. Nothing here opens a link: agent text is untrusted.
struct SelectableTextSheet: View {
    let text: String
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?

    init(text: String, title: String = "Select text") {
        self.text = text
        self.title = title
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                let links = MessageLinks.urls(in: text)
                if !links.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(links, id: \.self) { link in linkRow(link) }
                    }
                    .padding(16)
                    Divider().overlay(Theme.line)
                }
                SelectableText(text: text).frame(maxHeight: .infinity)
            }
            .background(Theme.surface)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Copy all") { copy(text, mark: "all") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.fontWeight(.semibold)
                }
            }
        }
    }

    private func linkRow(_ link: String) -> some View {
        Button { copy(link, mark: link) } label: {
            HStack(spacing: 10) {
                Lucide(.link, size: 15, color: Theme.muted)
                Text(verbatim: link)
                    .font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.ink)
                    .lineLimit(2).truncationMode(.middle).multilineTextAlignment(.leading)
                Spacer(minLength: 6)
                Text(copied == link ? "Copied" : "Copy").font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                Lucide(copied == link ? .check : .copy, size: 15, color: Theme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied == link ? "Copied" : "Copy link \(MessageLinks.host(link))")
    }

    private func copy(_ string: String, mark: String) {
        UIPasteboard.general.string = string
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        copied = mark
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            if copied == mark { copied = nil }
        }
    }
}

/// A read-only `UITextView`: the system's selection, which SwiftUI's `Text` cannot match for long text.
struct SelectableText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        // Nothing opens: a link in agent text is words to copy, not somewhere to go.
        view.dataDetectorTypes = []
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 24, right: 12)
        view.adjustsFontForContentSizeCategory = true
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textColor = UIColor(Theme.ink)
        view.alwaysBounceVertical = true
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        // Only when the words differ: writing the same text would drop a selection in progress.
        if view.text != text { view.text = text }
    }
}
#endif
