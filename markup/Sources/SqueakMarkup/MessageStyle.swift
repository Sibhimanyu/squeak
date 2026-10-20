import SwiftUI

/// How a message is set: type sizes and the colours of DESIGN.md §3.2. The apps pass their
/// own `Theme` colours; the defaults are neutral system colours so the package stands alone.
public struct MessageStyle: Sendable {
    /// Body text size in points (DESIGN §4.2: 13 on the Mac, 16 on the phone).
    public var bodySize: CGFloat
    /// Code size (DESIGN §4.2 `code`).
    public var codeSize: CGFloat
    /// Sizes for h1...h4.
    public var headingSizes: [CGFloat]
    /// Extra leading between wrapped lines, in points at the body size.
    public var lineSpacing: CGFloat
    /// Messages longer than this many lines fold behind "Show more".
    public var collapseLines: Int
    /// Scale text with the user's Dynamic Type setting (iOS).
    public var scalesWithDynamicType: Bool

    public var ink: Color
    public var muted: Color
    public var subtle: Color
    public var line: Color
    /// Code blocks and inline code.
    public var codeSurface: Color
    /// A table's header row.
    public var tableHeader: Color

    public init(
        bodySize: CGFloat, codeSize: CGFloat, headingSizes: [CGFloat], lineSpacing: CGFloat,
        collapseLines: Int = 60, scalesWithDynamicType: Bool = false,
        ink: Color = .primary, muted: Color = .secondary, subtle: Color = Color.secondary.opacity(0.7),
        line: Color = Color.primary.opacity(0.08), codeSurface: Color = Color.primary.opacity(0.06),
        tableHeader: Color = Color.primary.opacity(0.05)
    ) {
        self.bodySize = bodySize; self.codeSize = codeSize; self.headingSizes = headingSizes
        self.lineSpacing = lineSpacing; self.collapseLines = collapseLines
        self.scalesWithDynamicType = scalesWithDynamicType
        self.ink = ink; self.muted = muted; self.subtle = subtle; self.line = line
        self.codeSurface = codeSurface; self.tableHeader = tableHeader
    }

    /// Desktop: 13/19 body, 12 code (DESIGN §4.2).
    public static var mac: MessageStyle {
        MessageStyle(bodySize: 13, codeSize: 12, headingSizes: [17, 15, 13.5, 13], lineSpacing: 3.5)
    }

    /// Mobile: 16/22 body, 13 code, scaling with Dynamic Type.
    public static var phone: MessageStyle {
        MessageStyle(bodySize: 16, codeSize: 13, headingSizes: [21, 18, 16.5, 16], lineSpacing: 3, scalesWithDynamicType: true)
    }
}
