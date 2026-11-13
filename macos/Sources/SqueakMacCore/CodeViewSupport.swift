import AppKit

/// Pure helpers for the file viewer's text view and its line-number gutter.
public enum CodeViewSupport {
    /// What the gutter may paint. macOS 26 hands `drawHashMarksAndLabels(in:)` the whole scroll view's rect (500 wide for a
    /// 44 pt gutter), and filling all of it painted the background over the text and the header above the view.
    public static func gutterFill(dirty: NSRect, bounds: NSRect) -> NSRect { dirty.intersection(bounds) }

    /// Font and foreground on the whole storage, and on `typingAttributes`, so text set after the view was made (a file
    /// read asynchronously) and what is typed afterwards are never drawn in the default black.
    @MainActor
    public static func style(_ tv: NSTextView, font: NSFont, color: NSColor) {
        tv.font = font
        tv.textColor = color
        tv.typingAttributes = [.font: font, .foregroundColor: color]
        if let storage = tv.textStorage, storage.length > 0 {
            let all = NSRange(location: 0, length: storage.length)
            storage.addAttributes([.font: font, .foregroundColor: color], range: all)
        }
    }
}
