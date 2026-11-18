import SqueakIcons
import SqueakMacCore
import SwiftUI

// Room jobs (CONTRACT-jobs.md): the buttons of a duck's offer or claim and of Squeak's one quiet line. Nothing is taken or
// started until the person presses Go or Allow.

struct SmallButtonStyle: ButtonStyle {
    let role: RoomJobButton.Role
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: role == .primary ? .semibold : .regular))
            .foregroundStyle(role == .primary ? Theme.primaryText : (role == .quiet ? Theme.muted : Theme.ink))
            .padding(.horizontal, 10).frame(minHeight: 24)
            .background {
                switch role {
                case .primary: RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill)
                case .secondary: RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1))
                case .quiet: Color.clear
                }
            }
            .overlay { if role == .secondary { RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line) } }
            .opacity(isEnabled ? 1 : 0.5)
    }
}

// MARK: - Place (where a job's work happens)

/// What the chip's Change menu needs from the room: the pond's streams, the branch names already in use, and where a pick goes.
struct RoomPlaceContext: Sendable {
    var streams: [RoomStreamChoice] = []
    var taken: [String] = []
    var choose: @MainActor @Sendable (String, RoomJobPlace) -> Void = { _, _ in }
}

private struct RoomPlaceContextKey: EnvironmentKey { static let defaultValue = RoomPlaceContext() }
extension EnvironmentValues {
    var roomPlaceContext: RoomPlaceContext {
        get { self[RoomPlaceContextKey.self] }
        set { self[RoomPlaceContextKey.self] = newValue }
    }
}

/// "-> on <branch>" / "-> new stream <branch>" with a Change menu: the pond's streams, then a new stream with a name.
struct RoomPlaceChipView: View {
    let jobId: String
    let chip: RoomPlaceChip
    @Environment(\.roomPlaceContext) private var context
    @State private var naming = false
    @State private var draft = ""

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: chip.text).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, 8).frame(minHeight: 20)
                .background(Theme.surfaceRaised, in: Capsule()).overlay(Capsule().strokeBorder(Theme.line))
            Menu("Change") {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    switch item {
                    case .stream(let s, let selected):
                        Button { context.choose(jobId, .stream(workspaceId: s.workspaceId, branch: s.branch)) } label: {
                            if selected { Label(s.branch, systemImage: "checkmark") } else { Text(verbatim: s.branch) }
                        }
                    case .newStream(let prefill, _):
                        Divider()
                        Button("New stream\u{2026}") { draft = prefill; naming = true }
                    }
                }
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().font(.system(size: 12)).foregroundStyle(Theme.muted)
            .accessibilityLabel("Change where this goes")
            .popover(isPresented: $naming, arrowEdge: .bottom) { namer }
        }
        .accessibilityElement(children: .contain)
    }

    private var items: [RoomPlaceMenuItem] {
        RoomPlaces.menu(streams: context.streams, current: chip.place, prefill: chip.prefill)
    }

    private var problem: String? { RoomPlaces.branchProblem(draft, taken: context.taken) }

    private var namer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("New stream").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            TextField("Branch name", text: $draft).textFieldStyle(.roundedBorder).frame(width: 240).onSubmit(commit)
            if !draft.isEmpty, let p = problem { Text(verbatim: p).font(.system(size: 12)).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Spacer()
                Button("Cancel") { naming = false }.buttonStyle(SmallButtonStyle(role: .quiet))
                Button("Use") { commit() }.buttonStyle(SmallButtonStyle(role: .primary)).disabled(problem != nil)
            }
        }
        .padding(12).frame(width: 264)
    }

    private func commit() {
        guard problem == nil else { return }
        context.choose(jobId, .new(branch: draft.trimmingCharacters(in: .whitespacesAndNewlines)))
        naming = false
    }
}
