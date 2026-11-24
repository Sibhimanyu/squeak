import AppKit
import SqueakMacCore
import SwiftUI

// The Design tab of the right zone while a canvas is being edited: position, size, rotation and opacity; for text the
// font, size, weight, colour, alignment and line height; the fill, corner radius and border. Every change goes to the
// live page (`CanvasEditor.apply`), which draws it at once and reports the saved HTML.

/// Whether the right zone offers a Design tab: while a canvas has a live board. One flag for the window, like Artifacts.
@MainActor @Observable
final class CanvasDesignTab {
    static let shared = CanvasDesignTab()
    var editor: CanvasEditor?
    /// The Design tab is the one the zone shows.
    var shown = false
    var available: Bool { editor != nil }
    /// A selection on the board brings the tab forward.
    func reveal() { if editor != nil { shown = true } }

    static let title = "Design"
    static let symbol = "slider.horizontal.3"
}

struct CanvasDesignView: View {
    let editor: CanvasEditor

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                if let item = editor.selection.first {
                    header(item)
                    position(item)
                    if item.text { text(item) }
                    if !item.isImage { fill(item) }
                    border(item)
                    actions
                } else {
                    Text("Select something on the artboard to change it. Click a board to start; double-click text to type in it.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.hidden)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bg)
    }

    private func header(_ item: DesignItem) -> some View {
        let extra = editor.selection.count - 1
        return HStack {
            Text(verbatim: extra > 0 ? "\(item.label) and \(extra) more" : item.label).font(Typo.heading).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
        }
    }

    private func position(_ i: DesignItem) -> some View {
        let one = editor.selection.count == 1
        return group("Position") {
            HStack(spacing: Space.s) {
                NumberField(label: "X", value: i.x) { editor.apply(.x, .number($0)) }
                NumberField(label: "Y", value: i.y) { editor.apply(.y, .number($0)) }
            }
            HStack(spacing: Space.s) {
                NumberField(label: "W", value: i.w) { editor.apply(.w, .number($0)) }.disabled(!one)
                NumberField(label: "H", value: i.h) { editor.apply(.h, .number($0)) }.disabled(!one)
            }
            HStack(spacing: Space.s) {
                NumberField(label: "\u{21BB}", value: i.rotation, help: "Rotation in degrees") { editor.apply(.rotation, .number($0)) }
                NumberField(label: "%", value: i.opacity * 100, help: "Opacity") { editor.apply(.opacity, .number(DesignInput.opacity(percent: $0))) }
            }
        }
    }

    private func text(_ i: DesignItem) -> some View {
        let font = DesignFonts.match(i.fontFamily)
        return group("Text") {
            Menu {
                ForEach(DesignFonts.all) { f in Button(f.name) { editor.apply(.fontFamily, .string(f.css)) } }
            } label: {
                menuLabel(font?.name ?? DesignFonts.firstFamily(i.fontFamily))
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).accessibilityLabel("Font")
            HStack(spacing: Space.s) {
                NumberField(label: "Aa", value: i.fontSize, help: "Size in pixels") { editor.apply(.fontSize, .number($0)) }
                Menu {
                    ForEach(DesignFonts.weights, id: \.value) { w in Button(w.name) { editor.apply(.fontWeight, .string(w.value)) } }
                } label: {
                    menuLabel(DesignFonts.weights.first { $0.value == DesignFonts.weight(i.fontWeight) }?.name ?? "Regular")
                }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).accessibilityLabel("Weight")
            }
            ColorField(label: "Colour", hex: i.color, allowNone: false) { editor.apply(.color, .string($0), soft: $1) }
            HStack(spacing: Space.s) {
                alignment(i)
                NumberField(label: "\u{2195}", value: i.lineHeight, help: "Line height (0 is the font's own)") { editor.apply(.lineHeight, .number($0)) }
            }
        }
    }

    private func alignment(_ i: DesignItem) -> some View {
        let symbols = ["left": "text.alignleft", "center": "text.aligncenter", "right": "text.alignright", "justify": "text.justify"]
        return HStack(spacing: 2) {
            ForEach(DesignFonts.alignments, id: \.self) { a in
                Button { editor.apply(.textAlign, .string(a)) } label: {
                    Image(systemName: symbols[a] ?? "text.alignleft").font(.system(size: 12))
                        .foregroundStyle(i.textAlign == a ? Theme.ink : Theme.muted).frame(width: 26, height: 26)
                        .background(i.textAlign == a ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.chip))
                }
                .buttonStyle(.plain).help("Align \(a)").accessibilityLabel("Align \(a)")
            }
        }
    }

    private func fill(_ i: DesignItem) -> some View {
        group("Fill") {
            ColorField(label: "Fill", hex: i.background, allowNone: true) { editor.apply(.background, .string($0), soft: $1) }
            NumberField(label: "\u{25E0}", value: i.radius, help: "Corner radius") { editor.apply(.radius, .number($0)) }
        }
    }

    private func border(_ i: DesignItem) -> some View {
        group("Border") {
            HStack(spacing: Space.s) {
                NumberField(label: "px", value: i.borderWidth, help: "Border width") { editor.apply(.borderWidth, .number($0)) }
                Menu {
                    ForEach(DesignFonts.borderStyles, id: \.self) { s in Button(s.capitalized) { editor.apply(.borderStyle, .string(s)) } }
                } label: { menuLabel(i.borderStyle.capitalized) }
                    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).accessibilityLabel("Border style")
            }
            ColorField(label: "Colour", hex: i.borderColor, allowNone: false) { editor.apply(.borderColor, .string($0), soft: $1) }
        }
    }

    private var actions: some View {
        HStack(spacing: Space.s) {
            Button("Duplicate") { editor.duplicate() }.buttonStyle(SecondaryButtonStyle()).help("Duplicate (\u{2318}D)")
            Button("Delete") { editor.delete() }.buttonStyle(SecondaryButtonStyle()).help("Delete (\u{232B})")
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: title).font(Typo.meta).foregroundStyle(Theme.subtle)
            content()
        }
    }

    private func menuLabel(_ text: String) -> some View {
        HStack(spacing: 4) {
            Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9)).foregroundStyle(Theme.subtle)
        }
        .padding(.horizontal, Space.s).frame(height: 26).frame(maxWidth: .infinity)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.row))
        .contentShape(Rectangle())
    }
}

/// A labelled number the person types; Return applies it, a wrong entry puts the old value back.
private struct NumberField: View {
    let label: String
    let value: Double
    var help = ""
    let commit: (Double) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: label).font(Typo.meta).foregroundStyle(Theme.subtle).frame(minWidth: 14, alignment: .leading)
            TextField("", text: $text).textFieldStyle(.plain).font(Typo.body).monospacedDigit().focused($focused)
                .onSubmit { if let v = DesignInput.number(text) { commit(v) } else { text = DesignInput.display(value) } }
        }
        .padding(.horizontal, Space.s).frame(height: 26).frame(maxWidth: .infinity)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.row))
        .overlay(RoundedRectangle(cornerRadius: Radius.row).strokeBorder(focused ? Theme.lineStrong : Color.clear))
        .help(help)
        .onAppear { text = DesignInput.display(value) }
        .onChange(of: value) { _, v in if !focused { text = DesignInput.display(v) } }
        .onChange(of: focused) { _, f in if !f { text = DesignInput.display(value) } }
    }
}

/// A colour: the system picker (a drag is committed after a pause) and its hex; "none" clears a fill.
private struct ColorField: View {
    let label: String
    let hex: String
    let allowNone: Bool
    let commit: (String, Bool) -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Space.s) {
            ColorPicker("", selection: Binding(get: { Self.color(hex) }, set: { commit(Self.hex($0), true) }), supportsOpacity: false)
                .labelsHidden().accessibilityLabel(label)
            TextField(allowNone ? "None" : "#000000", text: $text).textFieldStyle(.plain).font(Typo.body).monospacedDigit().focused($focused)
                .onSubmit {
                    if let h = DesignInput.hex(text) { commit(h, false) }
                    else if allowNone, text.trimmingCharacters(in: .whitespaces).isEmpty || text.lowercased() == "none" { commit("none", false) }
                    else { text = hex.uppercased() }
                }
            if allowNone, !hex.isEmpty {
                Button { commit("none", false) } label: { Image(systemName: "xmark").font(.system(size: 9)).foregroundStyle(Theme.subtle) }
                    .buttonStyle(.plain).help("No fill").accessibilityLabel("No fill")
            }
        }
        .padding(.horizontal, Space.s).frame(height: 28).frame(maxWidth: .infinity)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.row))
        .onAppear { text = hex.uppercased() }
        .onChange(of: hex) { _, h in if !focused { text = h.uppercased() } }
    }

    static func color(_ hex: String) -> Color {
        guard let h = DesignInput.hex(hex), let v = UInt32(h.dropFirst(), radix: 16) else { return Color.clear }
        return Color(.sRGB, red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
    }

    static func hex(_ color: Color) -> String {
        let c = NSColor(color).usingColorSpace(.sRGB) ?? .black
        let f = { (x: CGFloat) in String(format: "%02x", Int((x * 255).rounded())) }
        return "#" + f(c.redComponent) + f(c.greenComponent) + f(c.blueComponent)
    }
}
