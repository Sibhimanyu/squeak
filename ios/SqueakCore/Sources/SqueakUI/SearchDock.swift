#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Home's foot (DESIGN.md §8.2): one 56pt capsule search field with a round New chat beside it, riding above the keyboard,
/// and over it, while the field is focused and empty, the suggestion chips. A chosen chip is a removable token above the field.
struct SearchDock: View {
    @Binding var query: String
    @Binding var chosen: [SearchToken]
    var focused: FocusState<Bool>.Binding
    let chips: [SmartSearch.Chip]
    let canStartChat: Bool
    let onNeedsYou: () -> Void
    let onNewChat: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var showsSuggestions: Bool { focused.wrappedValue && query.isEmpty }
    private var showsRow: Bool { showsSuggestions || !chosen.isEmpty }

    var body: some View {
        VStack(spacing: 10) {
            if showsRow { chipRow }
            HStack(spacing: 8) {
                field
                if canStartChat { newChat }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .padding(.top, 8)
        .background(alignment: .bottom) { scrim }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: showsRow)
    }

    /// From the screen's foot to the middle of the capsule the list is covered; above it the cover fades out.
    private var scrim: some View {
        // A gradient that fills whatever the dock is, never taller than it: a child bigger than its frame made layout
        // measure it again (1.20.32's launch hang was layout that never settled).
        LinearGradient(stops: [.init(color: Theme.bg.opacity(0), location: 0), .init(color: Theme.bg, location: 0.45)],
                       startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var field: some View {
        HStack(spacing: 10) {
            Lucide(.search, size: 18, color: Theme.muted).accessibilityHidden(true)
            TextField("Search ponds and chats…", text: $query)
                .focused(focused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Search ponds and chats")
            if !query.isEmpty {
                Button { Haptics.play(.tap); query = "" } label: {
                    Lucide(.x, size: 16, label: "Clear search", color: Theme.muted).frame(width: 44, height: 44).contentShape(Rectangle())
                }
            }
        }
        .padding(.leading, 18).padding(.trailing, query.isEmpty ? 18 : 4)
        .frame(minHeight: 56)
        .glassSurface(in: Capsule(), interactive: true)
        .contentShape(Capsule())
        .onTapGesture { focused.wrappedValue = true }
    }

    private var newChat: some View {
        Button { Haptics.play(.tap); onNewChat() } label: {
            Lucide(.squarePen, size: 20, label: "New chat", color: Theme.ink)
                .frame(width: 44, height: 44)
                .glassSurface(in: Circle(), interactive: true)
                .contentShape(Circle())
        }
        .buttonStyle(.press)
    }

    private var chipRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(chosen, id: \.self) { token in
                    Button { Haptics.play(.segment); chosen.removeAll { $0 == token } } label: {
                        HStack(spacing: 6) {
                            Text(token.title)
                            Lucide(.x, size: 12, color: Theme.primaryText).accessibilityHidden(true)
                        }
                        .chipLook(selected: true)
                    }
                    .buttonStyle(.press)
                    .accessibilityLabel("\(token.title) filter")
                    .accessibilityHint("Removes this filter")
                }
                if showsSuggestions {
                    ForEach(chips) { chip in
                        Button { Haptics.play(.segment); choose(chip) } label: { Text(chip.title).chipLook(selected: false) }
                            .buttonStyle(.press)
                            .accessibilityLabel(label(chip))
                            .accessibilityHint(hint(chip))
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize)
    }

    private func choose(_ chip: SmartSearch.Chip) {
        switch chip.kind {
        case .needsYou: onNeedsYou()
        case .token(let token): if !chosen.contains(token) { chosen.append(token) }
        }
    }

    private func label(_ chip: SmartSearch.Chip) -> String {
        if case .needsYou(let count) = chip.kind { return count == 0 ? "Waiting" : "Waiting, \(count)" }
        return chip.title
    }

    private func hint(_ chip: SmartSearch.Chip) -> String {
        if case .needsYou = chip.kind { return "Opens what is waiting for you" }
        return "Filters the list"
    }
}

private extension View {
    func chipLook(selected: Bool) -> some View {
        font(.subheadline.weight(.medium))
            .foregroundStyle(selected ? Theme.primaryText : Theme.ink)
            .padding(.horizontal, 14)
            .frame(minHeight: 40)
            .background(selected ? Theme.primaryFill : Theme.surface, in: Capsule())
            .overlay(Capsule().stroke(selected ? Color.clear : Theme.lineStrong))
            .contentShape(Capsule())
    }
}
#endif
