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
        tv.font = .systemFont(ofSize: 14)
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
        scroll.documentView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? PlaceholderTextView else { return }
        if tv.string != text { tv.string = text }
        tv.placeholder = placeholder
        tv.isEditable = isEnabled
        tv.alphaValue = isEnabled ? 1 : 0.5
        tv.needsDisplay = true
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

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.keyCode == 36 || event.keyCode == 76 {
            onCommandReturn?()
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
