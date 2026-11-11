import SqueakMacCore
import SqueakIcons
import SwiftUI

/// Small controls the New chat window draws itself so it matches the design: a full-width popup with a
/// chevron, a segmented control, a keycap, and a hairline.
struct NCPopup<Tag: Hashable>: View {
    var label: String
    var selection: Binding<Tag>
    var options: [(tag: Tag, title: String)]
    var height: CGFloat = Metrics.field
    /// The mark that goes before an option's name (the agent picker), in the menu and on the closed field.
    var mark: ((Tag) -> AgentMarkAsset?)? = nil
    /// One action after the choices, under a divider (the project menu's "New workspace in …").
    var extraItem: (title: String, action: () -> Void)? = nil

    var body: some View {
        SqueakMenu {
            ForEach(options.indices, id: \.self) { i in
                Button { selection.wrappedValue = options[i].tag } label: {
                    HStack(spacing: 8) {
                        if let m = mark?(options[i].tag) { AgentMark(m, size: 16) }
                        Text(options[i].title)
                        Spacer(minLength: 12)
                        Lucide(.check, size: 14, color: Theme.ink)
                            .opacity(options[i].tag == selection.wrappedValue ? 1 : 0)
                    }
                }
                .accessibilityAddTraits(options[i].tag == selection.wrappedValue ? .isSelected : [])
            }
            if let extraItem {
                Divider()
                Button(extraItem.title, action: extraItem.action)
            }
        } label: {
            HStack(spacing: 6) {
                if let m = mark?(selection.wrappedValue) { AgentMark(m, size: 16) }
                Text(options.first { $0.tag == selection.wrappedValue }?.title ?? "").font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 4)
                Lucide(.chevronDown, size: 13, color: Theme.muted)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
            .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        .accessibilityLabel(label)
    }
}

struct NCSegmented: View {
    var options: [(id: String, title: String)]
    var selection: String
    var mark: ((String) -> AgentMarkAsset?)? = nil
    var onPick: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { i in
                let o = options[i], on = o.id == selection
                Button { onPick(o.id) } label: {
                    HStack(spacing: 6) {
                        if let m = mark?(o.id) { AgentMark(m, size: 16) }
                        Text(o.title).lineLimit(1).minimumScaleFactor(0.55)
                    }
                        .font(.system(size: 12, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(on ? Theme.lineStrong : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .frame(height: Metrics.field)
        .background(Theme.surfaceRaised.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }
}

struct NCKeycap: View {
    var body: some View {
        HStack(spacing: 8) {
            Text("⌘").font(.system(size: 12))
            Image(systemName: "return").font(.system(size: 12))
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 10).frame(height: Metrics.button)
        .background(Theme.surfaceRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }
}

struct NCHairline: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1) }
}

/// A titled field: a small muted label over its control.
struct NCField<Content: View>: View {
    let title: String
    let content: Content
    init(_ title: String, @ViewBuilder _ content: () -> Content) { self.title = title; self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12)).foregroundStyle(Theme.muted)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Full-size form input with room around the caret and a focus border matching Squeak's controls.
struct NewPageTextFieldStyle: TextFieldStyle {
    @FocusState private var focused: Bool
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .focused($focused)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .frame(minHeight: 44)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control)
                .strokeBorder(focused ? Theme.ink.opacity(0.6) : Theme.line, lineWidth: focused ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: Radius.control))
            .onTapGesture { focused = true }
    }
}
