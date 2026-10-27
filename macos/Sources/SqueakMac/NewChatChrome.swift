import SqueakIcons
import SwiftUI

/// Small controls the New chat window draws itself so it matches the design: a full-width popup with a
/// chevron, a segmented control, a keycap, and a hairline.
struct NCPopup<Tag: Hashable>: View {
    var label: String
    var selection: Binding<Tag>
    var options: [(tag: Tag, title: String)]
    var height: CGFloat = 38

    var body: some View {
        Menu {
            Picker(label, selection: selection) {
                ForEach(options.indices, id: \.self) { Text(options[$0].title).tag(options[$0].tag) }
            }.pickerStyle(.inline).labelsHidden()
        } label: {
            HStack(spacing: 6) {
                Text(options.first { $0.tag == selection.wrappedValue }?.title ?? "").font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 4)
                Lucide(.chevronDown, size: 16, color: Theme.muted)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
            .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control + 2))
            .overlay(RoundedRectangle(cornerRadius: Radius.control + 2).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        .accessibilityLabel(label)
    }
}

struct NCSegmented: View {
    var options: [(id: String, title: String)]
    var selection: String
    var onPick: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { i in
                let o = options[i], on = o.id == selection
                Button { onPick(o.id) } label: {
                    Text(o.title).font(.system(size: 13, weight: on ? .semibold : .regular)).lineLimit(1).minimumScaleFactor(0.55)
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(on ? Theme.lineStrong : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .frame(height: 38)
        .background(Theme.surfaceRaised.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.control + 2))
        .overlay(RoundedRectangle(cornerRadius: Radius.control + 2).strokeBorder(Theme.line))
    }
}

struct NCKeycap: View {
    var body: some View {
        HStack(spacing: 10) {
            Text("⌘").font(.system(size: 13))
            Image(systemName: "return").font(.system(size: 13))
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 12).frame(height: 32)
        .background(Theme.surfaceRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }
}

struct NCHairline: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1) }
}
