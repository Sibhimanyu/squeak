import AppKit
import SqueakMacCore
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
    var moveCaretToEndOnFocus = false
    var onSend: () -> Void
    /// ⌘↩ when the field's Return sends: the conversation composer steers with it while the agent works.
    /// Nil: ⌘↩ sends only when `sendKey` is `.commandReturnSends`.
    var onCommandReturn: (() -> Void)?
    var onEscape: (() -> Void)?
    /// Reports the height the text wants (inset included), so a container can grow with it.
    var onContentHeight: ((CGFloat) -> Void)?
    var fontSize: CGFloat = 14
    /// A fixed line height (the composer card's 14/22); nil: the font's own. The reported height is then whole lines.
    var lineHeight: CGFloat?
    /// Inline chips (`InlineAttachments`): each token in `text` is drawn as one chip character; nil: tokens are plain text.
    var chips: InlineChipSource?
    /// ⌥↩: the quick composer's "steer into the running turn". Nil: ⌥↩ is a plain Return.
    var onOptionReturn: (() -> Void)?
    /// Images pasted (⌘V with an image and no text) or dropped on the field. Nil: the field takes none.
    var onImages: (([ImageSource]) -> Void)?
    /// Files dropped on the field (the room composer takes any file); nil: only pictures are taken, as before.
    var onFiles: (([URL]) -> Void)?
    /// The caret's UTF-16 offset after every edit or move (the picker's trigger reads it).
    var onCaret: ((Int) -> Void)?
    /// Keys the picker wants first while it is open: true when it took the key.
    var onPickerKey: ((ComposerPickerKey) -> Bool)?
    /// Lets the picker replace a range of the text at the caret's place.
    var handle: ComposerFieldHandle?
    /// The field gained or lost the keyboard (the composer box draws its focus ring from it).
    var onFocus: ((Bool) -> Void)?

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
        tv.chips = chips
        if let lineHeight { tv.applyLineHeight(lineHeight) }
        tv.setAccessibilityLabel("Message")
        tv.onCommandReturn = { [weak coordinator = context.coordinator] in coordinator?.parent.commandReturn() }
        tv.onOptionReturn = { [weak coordinator = context.coordinator] in
            guard let steer = coordinator?.parent.onOptionReturn else { return false }
            steer()
            return true
        }
        if onImages != nil || onFiles != nil { tv.registerForDraggedTypes([.fileURL, .png, .tiff]) }
        scroll.documentView = tv
        handle?.textView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? PlaceholderTextView else { return }
        tv.chips = chips
        if tv.storageText != text {
            tv.setStorageText(text)
            if lineHeight != nil { tv.reapplyLineHeight() }
        } else if chips != nil {
            // A thumbnail may have arrived: chips draw what the source has now.
            tv.needsDisplay = true
        }
        tv.placeholder = placeholder
        tv.onImages = onImages
        tv.onFiles = onFiles
        tv.onFocus = onFocus
        tv.isEditable = isEnabled
        tv.alphaValue = isEnabled ? 1 : 0.5
        tv.needsDisplay = true
        context.coordinator.reportHeight(tv)
        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async {
                tv.window?.makeFirstResponder(tv)
                if moveCaretToEndOnFocus {
                    let end = NSRange(location: tv.string.utf16.count, length: 0)
                    tv.setSelectedRange(end)
                    tv.scrollRangeToVisible(end)
                }
            }
        }
    }

    fileprivate func commandReturn() {
        if let onCommandReturn { onCommandReturn() } else if sendKey == .commandReturnSends { onSend() }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        var lastFocusToken = -1
        init(_ parent: ComposerField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? PlaceholderTextView else { return }
            tv.renderTypedTokens()
            parent.text = tv.storageText
            reportHeight(tv)
            parent.onCaret?(tv.storageOffset(ofDisplay: tv.selectedRange().location))
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let tv = notification.object as? PlaceholderTextView else { return }
            parent.onCaret?(tv.storageOffset(ofDisplay: tv.selectedRange().location))
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
            if let pick = parent.onPickerKey {
                let key: ComposerPickerKey? = switch selector {
                case #selector(NSResponder.moveUp(_:)): .up
                case #selector(NSResponder.moveDown(_:)): .down
                case #selector(NSResponder.insertNewline(_:)): .accept
                case #selector(NSResponder.insertTab(_:)): .accept
                case #selector(NSResponder.cancelOperation(_:)): .escape
                default: nil
                }
                if let key, pick(key) { return true }
            }
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
    /// Inline chips: tokens in the text are drawn as one attachment character each (`InlineAttachments`).
    var chips: InlineChipSource?
    private(set) var hoveredChip: NSTextAttachment?
    /// Set by `applyLineHeight`: every line is this tall, glyphs centred in it (the placeholder too).
    private(set) var fixedLineHeight: CGFloat?

    func applyLineHeight(_ height: CGFloat) {
        fixedLineHeight = height
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = height
        style.maximumLineHeight = height
        defaultParagraphStyle = style
        var typing = typingAttributes
        typing[.paragraphStyle] = style
        typing[.baselineOffset] = lineCentring
        typing[.font] = font
        typingAttributes = typing
        reapplyLineHeight()
    }

    /// Text set from outside (a draft, a picked mention) takes the same line height.
    func reapplyLineHeight() {
        guard fixedLineHeight != nil, let storage = textStorage, storage.length > 0 else { return }
        let all = NSRange(location: 0, length: storage.length)
        storage.addAttributes([.paragraphStyle: defaultParagraphStyle ?? .default, .baselineOffset: lineCentring], range: all)
    }

    // MARK: Inline chips

    private var baseAttributes: [NSAttributedString.Key: Any] {
        var a: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: 14), .foregroundColor: NSColor.labelColor]
        if fixedLineHeight != nil {
            a[.paragraphStyle] = defaultParagraphStyle ?? .default
            a[.baselineOffset] = lineCentring
        }
        return a
    }

    /// The stored text: every chip character back as its token, exactly as stored.
    var storageText: String { storage(of: NSRange(location: 0, length: (string as NSString).length)) }

    func storage(of range: NSRange) -> String {
        guard chips != nil, let storage = textStorage, string.contains(InlineAttachments.attachmentCharacter) else {
            return (string as NSString).substring(with: range)
        }
        var out = ""
        storage.enumerateAttribute(.squeakToken, in: range) { value, r, _ in
            if let raw = value as? String {
                // One token per attachment character in the run.
                let chars = (storage.string as NSString).substring(with: r)
                for c in chars { out += c == InlineAttachments.attachmentCharacter ? raw : String(c) }
            } else {
                out += (storage.string as NSString).substring(with: r).replacingOccurrences(of: String(InlineAttachments.attachmentCharacter), with: "")
            }
        }
        return out
    }

    /// The stored offset of a caret in the view (a chip before it counts as its whole token).
    func storageOffset(ofDisplay offset: Int) -> Int {
        guard chips != nil else { return offset }
        return (storage(of: NSRange(location: 0, length: min(offset, (string as NSString).length))) as NSString).length
    }

    /// Shows `text`: with chips, each token becomes one chip character; without, the plain text.
    func setStorageText(_ text: String) {
        guard chips != nil, text.contains("@⟦"), let storage = textStorage else {
            string = text
            return
        }
        let out = NSMutableAttributedString()
        let attrs = baseAttributes
        for seg in InlineAttachments.segments(text) {
            switch seg {
            case .text(let t): out.append(NSAttributedString(string: t, attributes: attrs))
            case .token(let t):
                out.append(InlineChipAttachment.string(t, source: chips, hovered: { [weak self] a in self?.hoveredChip === a }, attributes: attrs))
            }
        }
        storage.setAttributedString(out)
        typingAttributes = attrs
    }

    /// A token typed or pasted as text becomes a chip, the caret staying after it.
    func renderTypedTokens() {
        guard chips != nil, string.contains("@⟦") else { return }
        let text = storageText
        guard !InlineAttachments.tokens(in: text).isEmpty else { return }
        let caret = storageOffset(ofDisplay: selectedRange().location)
        setStorageText(text)
        setSelectedRange(NSRange(location: InlineAttachments.displayOffset(ofStorage: caret, in: text), length: 0))
    }

    /// Puts `token` where the caret is, with a space either side where the words need one, as one undoable edit.
    func insertAtCaret(_ token: String) {
        window?.makeFirstResponder(self)
        let range = selectedRange()
        let ns = string as NSString
        let before = range.location > 0 ? ns.substring(with: NSRange(location: range.location - 1, length: 1)) : "\n"
        let after = NSMaxRange(range) < ns.length ? ns.substring(with: NSRange(location: NSMaxRange(range), length: 1)) : "\n"
        let insert = (before.rangeOfCharacter(from: .whitespacesAndNewlines) == nil ? " " : "") + token
            + (after.rangeOfCharacter(from: .whitespacesAndNewlines) == nil ? " " : "")
        if shouldChangeText(in: range, replacementString: insert) {
            replaceCharacters(in: range, with: insert)
            didChangeText()
        }
    }

    /// Takes a chip (and only it) out, as one undoable edit.
    func removeChip(at index: Int) {
        let r = NSRange(location: index, length: 1)
        if shouldChangeText(in: r, replacementString: "") {
            replaceCharacters(in: r, with: "")
            didChangeText()
        }
    }

    /// The chip under a point (view coordinates): its character index and rect.
    func chip(at point: NSPoint) -> (index: Int, rect: NSRect, token: String)? {
        guard chips != nil, let lm = layoutManager, let tc = textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let p = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        var fraction: CGFloat = 0
        let glyph = lm.glyphIndex(for: p, in: tc, fractionOfDistanceThroughGlyph: &fraction)
        let index = lm.characterIndexForGlyph(at: glyph)
        guard index < storage.length, let raw = storage.attribute(.squeakToken, at: index, effectiveRange: nil) as? String else { return nil }
        let rect = lm.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: tc)
            .offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
        return rect.contains(point) ? (index, rect, raw) : nil
    }

    private func setHovered(_ a: NSTextAttachment?) {
        guard a !== hoveredChip else { return }
        hoveredChip = a
        needsDisplay = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.filter { $0.userInfo?["chips"] != nil }.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                       owner: self, userInfo: ["chips": true]))
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        guard chips != nil else { return }
        let p = convert(event.locationInWindow, from: nil)
        if let hit = chip(at: p) {
            setHovered(textStorage?.attribute(.attachment, at: hit.index, effectiveRange: nil) as? NSTextAttachment)
            NSCursor.pointingHand.set()
        } else {
            setHovered(nil)
        }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        setHovered(nil)
    }

    /// A click on a chip opens its preview; on its ✕ (shown on hover) removes it. Anywhere else is the text's.
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let hit = chip(at: p), let token = InlineAttachments.tokens(in: hit.token).first else { return super.mouseDown(with: event) }
        if p.x >= hit.rect.maxX - InlineChipImage.removeSlot - 2 {
            setHovered(nil)
            removeChip(at: hit.index)
        } else {
            chips?.open(token)
        }
    }

    /// Copy and cut carry the stored tokens, so a chip pasted back (here or in another composer) is the same chip.
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        guard chips != nil else { return super.writeSelection(to: pboard, types: types) }
        let text = selectedRanges.map { storage(of: $0.rangeValue) }.joined(separator: "\n")
        pboard.clearContents()
        return pboard.setString(text, forType: .string)
    }

    /// TextKit puts a tall line's extra space above the glyphs; raising them by half of it centres them.
    private var lineCentring: CGFloat {
        guard let fixedLineHeight, let font else { return 0 }
        let natural = NSLayoutManager().defaultLineHeight(for: font)
        return max(0, (fixedLineHeight - natural) / 2)
    }

    var onCommandReturn: (() -> Void)?
    /// True when it took the key; false lets ⌥↩ be an ordinary Return.
    var onOptionReturn: (() -> Bool)?
    var onImages: (([ImageSource]) -> Void)?
    var onFiles: (([URL]) -> Void)?
    var onFocus: ((Bool) -> Void)?

    private func droppedFiles(_ pb: NSPasteboard) -> [URL] {
        guard onFiles != nil else { return [] }
        return (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { DispatchQueue.main.async { [weak self] in self?.onFocus?(true) } }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { DispatchQueue.main.async { [weak self] in self?.onFocus?(false) } }
        return ok
    }

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
        if !droppedFiles(sender.draggingPasteboard).isEmpty { return .copy }
        if onImages != nil, !ImagePasteboard.sources(sender.draggingPasteboard, rawNeedsNoText: false).isEmpty { return .copy }
        return super.draggingEntered(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        let files = droppedFiles(sender.draggingPasteboard)
        if let onFiles, !files.isEmpty { onFiles(files); return true }
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
        let origin = NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 5), y: textContainerInset.height)
        if fixedLineHeight != nil {
            // Laid out like the text itself (same line height and centring), so typing never moves the first line.
            // Level with the first typed line (TextKit's fixed-height line plus `lineCentring`), measured in the snapshots.
            placeholder.draw(at: NSPoint(x: origin.x, y: origin.y - lineCentring * 0.4), withAttributes: attrs)
        } else {
            placeholder.draw(at: origin, withAttributes: attrs)
        }
    }
}

enum ComposerPickerKey { case up, down, accept, escape }

/// A reference to the field's text view so a picker can replace the `@word` or `/word` under the caret; the
/// edit goes through the text view, so undo, the binding and the caret all follow.
@MainActor
final class ComposerFieldHandle {
    weak var textView: NSTextView?

    /// The window x (the SwiftUI global x) of the character at UTF-16 `offset`: where the typed `@` or `/` sits, which the
    /// suggestion list anchors to. Nil when the field is not laid out yet.
    func windowX(ofCharacterAt storageOffset: Int) -> CGFloat? {
        let offset = displayOffset(storageOffset)
        guard let tv = textView, let lm = tv.layoutManager, tv.window != nil, offset >= 0, offset <= (tv.string as NSString).length else { return nil }
        let glyph = lm.glyphIndexForCharacter(at: min(offset, max((tv.string as NSString).length - 1, 0)))
        let line = lm.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let x = line.minX + lm.location(forGlyphAt: glyph).x + tv.textContainerOrigin.x
        return tv.convert(NSPoint(x: x, y: 0), to: nil).x
    }

    /// A stored offset (what the pickers compute on the text) as the view's offset: chips are one character there.
    private func displayOffset(_ storageOffset: Int) -> Int {
        guard let tv = textView as? PlaceholderTextView, tv.chips != nil else { return storageOffset }
        return InlineAttachments.displayOffset(ofStorage: storageOffset, in: tv.storageText)
    }

    /// Puts a token at the caret (an inline picture), as one undoable edit.
    func insertAtCaret(_ token: String) { (textView as? PlaceholderTextView)?.insertAtCaret(token) }

    func replace(_ storageRange: NSRange, with string: String) {
        let start = displayOffset(storageRange.location)
        let range = NSRange(location: start, length: displayOffset(NSMaxRange(storageRange)) - start)
        guard let tv = textView, NSMaxRange(range) <= (tv.string as NSString).length else { return }
        tv.window?.makeFirstResponder(tv)
        if tv.shouldChangeText(in: range, replacementString: string) {
            tv.replaceCharacters(in: range, with: string)
            tv.didChangeText()
            tv.setSelectedRange(NSRange(location: range.location + (string as NSString).length, length: 0))
        }
    }
}
