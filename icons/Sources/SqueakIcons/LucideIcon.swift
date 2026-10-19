import SwiftUI

/// One drawable piece of an icon, in Lucide's 24x24 grid.
public enum LucideElement: Equatable, Sendable {
    case path(String)
    case circle(cx: Double, cy: Double, r: Double)
    case ellipse(cx: Double, cy: Double, rx: Double, ry: Double)
    case line(x1: Double, y1: Double, x2: Double, y2: Double)
    case polyline([Double])
    case polygon([Double])
    case rect(x: Double, y: Double, width: Double, height: Double, rx: Double, ry: Double)

    var commands: [PathCommand] {
        switch self {
        case .path(let d): return SVGPath.commands(d)
        case .circle(let cx, let cy, let r): return SVGPath.ellipse(cx: cx, cy: cy, rx: r, ry: r)
        case .ellipse(let cx, let cy, let rx, let ry): return SVGPath.ellipse(cx: cx, cy: cy, rx: rx, ry: ry)
        case .line(let x1, let y1, let x2, let y2):
            return [.move(CGPoint(x: x1, y: y1)), .line(CGPoint(x: x2, y: y2))]
        case .polyline(let v): return SVGPath.poly(v, closed: false)
        case .polygon(let v): return SVGPath.poly(v, closed: true)
        case .rect(let x, let y, let w, let h, let rx, let ry):
            return SVGPath.rect(x: x, y: y, width: w, height: h, rx: rx, ry: ry)
        }
    }
}

extension LucideName {
    /// Side of Lucide's design grid.
    public static let grid: CGFloat = 24

    /// The icon on the 24x24 grid, unscaled.
    public var gridPath: Path {
        var p = Path()
        for el in elements {
            for c in el.commands {
                switch c {
                case .move(let a): p.move(to: a)
                case .line(let a): p.addLine(to: a)
                case .cubic(let c1, let c2, let e): p.addCurve(to: e, control1: c1, control2: c2)
                case .close: p.closeSubpath()
                }
            }
        }
        return p
    }
}

/// The icon as a `Shape`: the 24 grid scaled to fit the frame, centred.
/// Stroke it yourself, or use `Lucide`, which does it at the design stroke.
public struct LucideIcon: Shape {
    public let name: LucideName
    public init(_ name: LucideName) { self.name = name }

    public func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / LucideName.grid
        let dx = rect.minX + (rect.width - LucideName.grid * scale) / 2
        let dy = rect.minY + (rect.height - LucideName.grid * scale) / 2
        return name.gridPath.applying(
            CGAffineTransform(scaleX: scale, y: scale).concatenating(CGAffineTransform(translationX: dx, y: dy)))
    }
}

/// `Lucide(.search, size: 16)`: a stroked icon, 1.5pt line, round caps and joins
/// (DESIGN.md 6.4: 16 in lists, 20 in toolbars). The line stays 1.5pt at any
/// size, as the design asks, rather than scaling with the grid.
///
/// Colour: `color` if given, else `.secondary`. Pass `Theme.muted` explicitly
/// for the exact muted token; a `.foregroundStyle` outside the view only
/// tints the hierarchical `.secondary`.
/// Decorative (hidden from accessibility) unless a `label` is given.
public struct Lucide: View {
    public static let strokeWidth: CGFloat = 1.5

    let name: LucideName
    let size: CGFloat
    let label: LocalizedStringKey?
    let color: AnyShapeStyle

    public init(
        _ name: LucideName, size: CGFloat = 16, label: LocalizedStringKey? = nil,
        color: (any ShapeStyle)? = nil
    ) {
        self.name = name
        self.size = size
        self.label = label
        self.color = color.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.secondary)
    }

    public var body: some View {
        let icon = LucideIcon(name)
            .stroke(color, style: StrokeStyle(lineWidth: Self.strokeWidth, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
        if let label {
            icon.accessibilityElement().accessibilityLabel(label)
        } else {
            icon.accessibilityHidden(true)
        }
    }
}
