import AppKit
import SwiftUI

/// A plain-text multi-line field. Return either sends (quick composer) or inserts a
/// newline (conversation composer, where ⌘↩ sends). Shift-Return is always a newline.
struct ComposerField: NSViewRepresentable {
    enum SendKey { case returnSends, commandReturnSends }

    @Binding var text: String
    var sendKey: SendKey
    var placeholder: String
    var isEnabled = true
    var focusToken = 0
    var onSend: () -> Void
    var onEscape: (() -> Void)?
    /// Reports the height the text wants (inset included), so a container can grow with it.
    var onContentHeight: ((CGFloat) -> Void)?
    var fontSize: CGFloat = 14
    /// ⌥↩: the quick composer's "steer into the running turn". Nil: ⌥↩ is a plain Return.
    var onOptionReturn: (() -> Void)?
    /// Images pasted (⌘V with an image and no text) or dropped on the field. Nil: the field takes none.
    var onImages: (([ImageSource]) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let tv = PlaceholderTextView()
        tv.delegate = context.coordinator
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.font = .systemFont(ofSize: fontSize)
        tv.textColor = .labelColor
        tv.textContainerInset = NSSize(width: 4, height: 6)
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        tv.placeholder = placeholder
        tv.setAccessibilityLabel("Message")
        tv.onCommandReturn = { [weak coordinator = context.coordinator] in coordinator?.parent.commandReturn() }
        tv.onOptionReturn = { [weak coordinator = context.coordinator] in
            guard let steer = coordinator?.parent.onOptionReturn else { return false }
            steer()
            return true
        }
        if onImages != nil { tv.registerForDraggedTypes([.fileURL, .png, .tiff]) }
        scroll.documentView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? PlaceholderTextView else { return }
        if tv.string != text { tv.string = text }
        tv.placeholder = placeholder
        tv.onImages = onImages
        tv.isEditable = isEnabled
        tv.alphaValue = isEnabled ? 1 : 0.5
        tv.needsDisplay = true
        context.coordinator.reportHeight(tv)
        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        }
    }

    fileprivate func commandReturn() {
        if sendKey == .commandReturnSends { onSend() }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        var lastFocusToken = -1
        init(_ parent: ComposerField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
            reportHeight(tv)
        }

        private var lastHeight: CGFloat = 0
        func reportHeight(_ tv: NSTextView) {
            guard let report = parent.onContentHeight, let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let h = ceil(lm.usedRect(for: tc).height + tv.textContainerInset.height * 2)
            guard abs(h - lastHeight) > 0.5 else { return }
            lastHeight = h
            DispatchQueue.main.async { report(h) }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if parent.sendKey == .returnSends {
                    parent.onSend()
                    return true
                }
                return false
            case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                if let esc = parent.onEscape {
                    esc()
                    return true
                }
                return false
            default:
                return false
            }
        }
    }
}

final class PlaceholderTextView: NSTextView {
    var placeholder = ""
    var onCommandReturn: (() -> Void)?
    /// True when it took the key; false lets ⌥↩ be an ordinary Return.
    var onOptionReturn: (() -> Bool)?
    var onImages: (([ImageSource]) -> Void)?

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        onImages == nil ? super.readablePasteboardTypes : super.readablePasteboardTypes + [.png, .tiff, .fileURL]
    }

    /// An image on the clipboard is attached; anything else pastes as it always did.
    override func paste(_ sender: Any?) {
        if let onImages {
            let found = ImagePasteboard.sources(.general, rawNeedsNoText: true)
            if !found.isEmpty { onImages(found); return }
        }
        super.paste(sender)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        if onImages != nil, !ImagePasteboard.sources(sender.draggingPasteboard, rawNeedsNoText: false).isEmpty { return .copy }
        return super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        if let onImages {
            let found = ImagePasteboard.sources(sender.draggingPasteboard, rawNeedsNoText: false)
            if !found.isEmpty { onImages(found); return true }
        }
        return super.performDragOperation(sender)
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.keyCode == 36 || event.keyCode == 76 {
            onCommandReturn?()
            return
        }
        if event.modifierFlags.contains(.option), event.keyCode == 36 || event.keyCode == 76, onOptionReturn?() == true {
            return
        }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: 14), .foregroundColor: NSColor.placeholderTextColor]
        placeholder.draw(at: NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 5), y: textContainerInset.height), withAttributes: attrs)
    }
}
