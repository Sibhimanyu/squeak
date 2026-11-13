import AppKit
import QuickLookUI
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the file viewer in the centre: a file opened from the Files tab replaces the chat under the tab
// strip. Read-only by default (JetBrains Mono 12, line numbers); Edit switches to an editable text view and ⌘S saves,
// refused when the file changed on disk since it was opened. No syntax colour: it would need a grammar per language.

struct FileViewer: View {
    let files: FilesModel
    let file: OpenFile
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.line).frame(height: 1)
            if file.conflict != nil { conflictBanner }
            switch file.content {
            case .text:
                CodeTextView(text: Bindable(file).edited, editable: file.editing, jump: file.jump)
                    .id(file.path).clipped()
            case .image(let image):
                ImageCanvas(image: image, name: file.name)
            case .preview(let url):
                QuickLookPreview(url: url)
            case .listing(let url, let entries):
                FolderListing(files: files, folder: url, entries: entries)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .background {
            // ⌘S, wherever focus is inside the window (the editor does not take it).
            Button("Save") { files.save(file) }.keyboardShortcut("s", modifiers: .command)
                .disabled(!file.dirty || file.saving).opacity(0).accessibilityHidden(true)
        }
        .task(id: file.path) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await files.checkDisk(file)
            }
        }
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Lucide(.fileText, size: 14, color: Theme.muted)
            Text(verbatim: file.path).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.head)
            if file.dirty { Text("Edited").font(Typo.meta).foregroundStyle(Theme.muted) }
            if file.outside { Text("Outside this stream").font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1) }
            if let note = file.note { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.negative).lineLimit(1) }
            Spacer(minLength: Space.s)
            if case .text = file.content, !file.outside {
                if file.editing {
                    Button("Done") { file.editing = false }.buttonStyle(SecondaryButtonStyle())
                        .help("Back to reading; your edits stay")
                } else {
                    Button("Edit") { file.editing = true }.buttonStyle(SecondaryButtonStyle())
                }
                Button { files.save(file) } label: {
                    HStack(spacing: 6) {
                        if file.saving { DotGridLoader(size: 12) }
                        Text("Save")
                    }
                }
                .buttonStyle(PrimaryButtonStyle()).disabled(!file.dirty || file.saving)
                .help("Save (⌘S)")
            }
            Button { if let url = files.url(for: file.path) { NSWorkspace.shared.activateFileViewerSelecting([url]) } } label: {
                Lucide(.folder, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Show in Finder").accessibilityLabel("Show in Finder")
            Button { if let url = files.url(for: file.path) { NSWorkspace.shared.open(url) } } label: {
                Lucide(.externalLink, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Open with the default app").accessibilityLabel("Open with the default app")
        }
        .padding(.horizontal, Space.m).frame(height: 40)
    }

    private var conflictBanner: some View {
        HStack(spacing: Space.s) {
            Lucide(.triangleAlert, size: 14, color: Theme.warning)
            Text(file.conflict == .deletedOnDisk ? "This file was deleted on disk." : "This file changed on disk since you opened it.")
                .font(Typo.body).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
            if file.conflict == .changedOnDisk {
                Button("Reload") { files.reload(file) }.buttonStyle(SecondaryButtonStyle())
                    .help("Take the file from disk and drop your edits")
            }
            if file.dirty {
                Button(file.conflict == .deletedOnDisk ? "Save anyway" : "Overwrite") { files.save(file, overwrite: true) }
                    .buttonStyle(SecondaryButtonStyle()).help("Write your version over what is on disk")
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, 8)
        .background(Theme.surfaceRaised)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

/// A file tab in the strip: the name (mono), a dot while edited, and a close button.
struct FileTab: View {
    let files: FilesModel
    let file: OpenFile

    var body: some View {
        let selected = files.activePath == file.path
        HStack(spacing: 4) {
            Button { files.activePath = file.path } label: {
                HStack(spacing: 5) {
                    Lucide(.fileText, size: 12, color: Theme.muted)
                    Text(verbatim: file.name).font(Typo.code).foregroundStyle(selected ? Theme.ink : Theme.muted).lineLimit(1)
                    if file.dirty { Circle().fill(Theme.muted).frame(width: 6, height: 6).accessibilityLabel("Unsaved changes") }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { files.close(file.path) } label: {
                Lucide(.x, size: 11, color: Theme.muted).frame(width: 18, height: 18).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Close \(file.name)").accessibilityLabel("Close \(file.name)")
        }
        .padding(.leading, 10).padding(.trailing, 4).frame(height: 28).frame(maxWidth: 220)
        .background(selected ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// "Save changes to X?" when a tab with unsaved edits is closed. Attached once, to the centre column.
struct FileCloseGuard: ViewModifier {
    let files: FilesModel?

    func body(content: Content) -> some View {
        let path = files?.closeAsk
        let name = path.map(ChangesPresentation.fileName) ?? ""
        content.confirmationDialog(
            "Save changes to \(name)?",
            isPresented: Binding(get: { files?.closeAsk != nil }, set: { if !$0 { files?.closeAsk = nil } }),
            titleVisibility: .visible
        ) {
            Button("Save") {
                if let files, let path, let f = files.open.first(where: { $0.path == path }) { files.save(f, thenClose: true) }
            }
            Button("Don't save", role: .destructive) { if let path { files?.close(path, force: true) } }
            Button("Cancel", role: .cancel) { files?.closeAsk = nil }
        } message: {
            Text("Your edits to this file are lost if you don't save them.")
        }
    }
}

// MARK: Text view

/// A scrolling text view with a line-number gutter: `JetBrains Mono 12`, no wrapping, read-only unless `editable`.
struct CodeTextView: NSViewRepresentable {
    @Binding var text: String
    let editable: Bool
    var jump: LineJump?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = true
        scroll.backgroundColor = Self.color(Tokens.Dark.bg, Tokens.Light.bg)
        scroll.hasHorizontalScroller = true
        guard let tv = scroll.documentView as? NSTextView else { return scroll }
        tv.delegate = context.coordinator
        tv.backgroundColor = Self.color(Tokens.Dark.bg, Tokens.Light.bg)
        tv.insertionPointColor = Self.color(Tokens.Dark.ink, Tokens.Light.ink)
        tv.isRichText = false
        tv.allowsUndo = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.isGrammarCheckingEnabled = false
        tv.textContainerInset = NSSize(width: 6, height: 8)
        tv.isHorizontallyResizable = true
        tv.textContainer?.widthTracksTextView = false
        tv.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.isSelectable = true
        tv.isEditable = editable
        tv.string = text
        CodeViewSupport.style(tv, font: TerminalStyle.font, color: Self.color(Tokens.Dark.ink, Tokens.Light.ink))
        let ruler = LineNumberRuler(textView: tv, scroll: scroll)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        Self.apply(jump, to: tv, context.coordinator)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? NSTextView else { return }
        if tv.isEditable != editable { tv.isEditable = editable }
        if tv.string != text {
            let selection = tv.selectedRange()
            context.coordinator.updating = true
            tv.string = text
            CodeViewSupport.style(tv, font: TerminalStyle.font, color: Self.color(Tokens.Dark.ink, Tokens.Light.ink))
            context.coordinator.updating = false
            let length = (tv.string as NSString).length
            tv.setSelectedRange(NSRange(location: min(selection.location, length), length: 0))
        }
        (scroll.verticalRulerView as? LineNumberRuler)?.textChanged()
        Self.apply(jump, to: tv, context.coordinator)
    }

    /// Selects and scrolls to a line once (a content-search hit); the same request is not repeated.
    private static func apply(_ jump: LineJump?, to tv: NSTextView, _ c: Coordinator) {
        guard let jump, c.lastJump != jump.id else { return }
        c.lastJump = jump.id
        DispatchQueue.main.async {
            let ns = tv.string as NSString
            var idx = 0, line = 1
            while line < jump.line, idx < ns.length { idx = NSMaxRange(ns.lineRange(for: NSRange(location: idx, length: 0))); line += 1 }
            let r = ns.lineRange(for: NSRange(location: min(idx, ns.length), length: 0))
            tv.setSelectedRange(r)
            tv.scrollRangeToVisible(r)
            tv.showFindIndicator(for: r)
        }
    }

    private static func color(_ dark: UInt32, _ light: UInt32) -> NSColor {
        NSColor(name: nil) { a in NSColor(hex: a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light) }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: CodeTextView
        var updating = false
        var lastJump: UUID?
        init(_ parent: CodeTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard !updating, let tv = notification.object as? NSTextView else { return }
            if parent.text != tv.string { parent.text = tv.string }
            (tv.enclosingScrollView?.verticalRulerView as? LineNumberRuler)?.textChanged()
        }
    }
}

/// Line numbers in the gutter, drawn for the visible lines only. Lines do not wrap, so a line is a paragraph.
@MainActor
final class LineNumberRuler: NSRulerView {
    private weak var textView: NSTextView?
    private var lineStarts: [Int] = [0]
    private var digits = 3

    init(textView: NSTextView, scroll: NSScrollView) {
        self.textView = textView
        super.init(scrollView: scroll, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 44
        NotificationCenter.default.addObserver(
            self, selector: #selector(redraw), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        scroll.contentView.postsBoundsChangedNotifications = true
        textChanged()
    }

    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func redraw() { needsDisplay = true }

    func textChanged() {
        guard let tv = textView else { return }
        let ns = tv.string as NSString
        var starts = [0]
        var i = 0
        while i < ns.length {
            let r = ns.lineRange(for: NSRange(location: i, length: 0))
            i = NSMaxRange(r)
            if i < ns.length || (i == ns.length && r.length > 0 && ns.character(at: i - 1) == 10) { starts.append(i) }
        }
        lineStarts = starts
        let d = max(3, String(starts.count).count)
        if d != digits { digits = d; ruleThickness = CGFloat(d) * 8 + 20 }
        needsDisplay = true
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let tv = textView, let layout = tv.layoutManager, let container = tv.textContainer else { return }
        let bg = NSColor(name: nil) { a in NSColor(hex: a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? Tokens.Dark.bg : Tokens.Light.bg) }
        bg.setFill()
        CodeViewSupport.gutterFill(dirty: rect, bounds: bounds).fill()
        let subtle = NSColor(name: nil) { a in NSColor(hex: a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? Tokens.Dark.subtle : Tokens.Light.subtle) }
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: subtle]
        let origin = tv.textContainerOrigin.y
        let visible = tv.visibleRect
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        let chars = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        // First visible line: the last start at or before the first visible character.
        var lo = 0, hi = lineStarts.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if lineStarts[mid] <= chars.location { lo = mid } else { hi = mid - 1 }
        }
        var line = lo
        let length = (tv.string as NSString).length
        while line < lineStarts.count, lineStarts[line] <= NSMaxRange(chars) {
            let start = lineStarts[line]
            var frag = NSRect.zero
            if start < length {
                frag = layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: start), effectiveRange: nil)
            } else {
                frag = layout.extraLineFragmentRect
                if frag == .zero, length == 0 { frag = NSRect(x: 0, y: 0, width: 1, height: (tv.font?.boundingRectForFont.height ?? 14)) }
            }
            if frag != .zero {
                let y = frag.minY + origin - visible.minY
                let label = String(line + 1) as NSString
                let size = label.size(withAttributes: attrs)
                label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y + (frag.height - size.height) / 2), withAttributes: attrs)
            }
            line += 1
        }
    }
}

// MARK: Preview and folder listing

/// Any file the viewer cannot read as text or an image (video, an archive, a big PDF): Quick Look inside the tab.
struct QuickLookPreview: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> NSView {
        guard let view = QLPreviewView(frame: .zero, style: .normal) else { return NSView() }
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        guard let view = view as? QLPreviewView else { return }
        if (view.previewItem as? NSURL)?.absoluteURL != url { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ view: NSView, coordinator: ()) { (view as? QLPreviewView)?.close() }
}

/// A folder outside the chat's folder, as a list: a click on a name opens it inside Squeak the same way.
struct FolderListing: View {
    let files: FilesModel
    let folder: URL
    let entries: [FileEntry]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if entries.isEmpty { Text("This folder is empty.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m) }
                ForEach(entries) { e in
                    Button { files.openPath(URL(fileURLWithPath: e.path)) } label: {
                        HStack(spacing: Space.s) {
                            Lucide(e.isDirectory ? .folder : .fileText, size: 13, color: Theme.muted)
                            Text(verbatim: e.name).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, Space.m).frame(height: 26).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).pointerHand()
                }
            }
            .padding(.vertical, Space.xs)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }
}

/// The short "Not found" line over the centre; it clears itself.
struct PathToast: ViewModifier {
    let files: FilesModel?

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let text = files?.toast {
                Text(verbatim: text).font(Typo.meta).foregroundStyle(Theme.ink)
                    .padding(.horizontal, Space.m).padding(.vertical, 8)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                    .padding(.bottom, Space.l)
                    .accessibilityLabel(text)
                    .transition(.opacity)
            }
        }
        .animation(Motion.quick, value: files?.toast)
    }
}
