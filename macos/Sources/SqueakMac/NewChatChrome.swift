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

    var body: some View {
        Menu {
            Picker(label, selection: selection) {
                ForEach(options.indices, id: \.self) { i in
                    if let m = mark?(options[i].tag), let img = AgentMarkImages.sized(m, 16) {
                        Label { Text(options[i].title) } icon: { Image(nsImage: img) }.tag(options[i].tag)
                    } else {
                        Text(options[i].title).tag(options[i].tag)
                    }
                }
            }.pickerStyle(.inline).labelsHidden()
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
