import SqueakIcons
import SqueakMacCore
import SwiftUI

// Room Tasks: the buttons of a duck's offer or claim and of Squeak's one quiet line. Nothing is taken or
// started until the person presses Go or Allow.

struct SmallButtonStyle: ButtonStyle {
    let role: RoomTaskButton.Role
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
    var choose: @MainActor @Sendable (String, RoomTaskPlace) -> Void = { _, _ in }
    /// A Room message of a Task's discussion in or out: (task id, message id, included).
    var include: @MainActor @Sendable (String, String, Bool) -> Void = { _, _, _ in }
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

// MARK: - A Task with its state

/// One Task in the Room: its title and state, the Room messages it carries (trimmable before it is sent) and Drop.
struct RoomTaskCardView: View {
    let card: RoomTaskCard
    let act: (String, RoomTaskAction, String?) -> Void
    var open: (() -> Void)?
    @Environment(\.roomPlaceContext) private var context
    @State private var trimming = false
    @State private var hoverOwner = false
    @Environment(\.roomThreads) private var threads

    /// The Duck that has the Task: its avatar and name are one hit target, like everywhere else in the Room.
    @ViewBuilder private var owner: some View {
        if let target = PondClick.owner(of: card), let thread = threads.first(where: { $0.sessionId == target.duck }) {
            HStack(spacing: 6) {
                DuckHitAvatar(target: target, name: thread.duckName, hovering: hoverOwner, set: { hoverOwner = $0 }, avatar: AnyView(DuckAvatar(sessionId: thread.sessionId, agent: thread.agent, size: 20)))
                DuckHitName(target: target, name: thread.duckName, hovering: hoverOwner, set: { hoverOwner = $0 }) {
                    Text(verbatim: thread.duckName).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                }
            }
        }
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: card.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                    .onTapGesture { open?() }.pointerHand(open != nil)
                stateBadge
                owner
                if card.trimmable {
                    Button { trimming = true } label: {
                        Text(verbatim: card.discussionSummary).font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain).pointerHand().accessibilityLabel("Choose the messages this task carries")
                    .popover(isPresented: $trimming, arrowEdge: .bottom) { trimList }
                }
                if card.canDrop { Button("Drop") { act(card.taskId, .drop, nil) }.buttonStyle(SmallButtonStyle(role: .quiet)) }
                if let open { Button("Open", action: open).buttonStyle(SmallButtonStyle(role: .secondary)) }
            }
            if let line = card.routing { routingLine(line) }
            if let p = card.parentTitle { Text(verbatim: "Part of \(p)").font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1) }
            if let r = card.result { Text(verbatim: r).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(2).multilineTextAlignment(.center) }
            if let e = card.error { Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: 560)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line))
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine).accessibilityLabel(card.spoken)
    }

    /// The one quiet routing line; while the Task waits, one tap gives it to another Duck.
    private func routingLine(_ line: RoomRoutingLine) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: line.text).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            if !line.choices.isEmpty {
                Menu {
                    ForEach(line.choices) { c in
                        Button(c.name) { act(card.taskId, .reroute(duckId: c.duckId), nil) }
                    }
                } label: {
                    Text("Change").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Give this task to another duck")
            }
        }
    }

    private var stateBadge: some View {
        Text(verbatim: card.stateLabel).font(.system(size: 11, weight: .medium))
            .foregroundStyle(card.state == .blocked ? Theme.negative : Theme.muted)
            .padding(.horizontal, 8).frame(minHeight: 20)
            .background(Theme.surfaceRaised, in: Capsule()).overlay(Capsule().strokeBorder(Theme.line))
    }

    private var trimList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Messages this task carries").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
            Text("Untick what the duck does not need. It gets the rest with the task.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(card.discussion) { m in
                        Toggle(isOn: Binding(
                            get: { !card.excluded.contains(m.id) },
                            set: { context.include(card.taskId, m.id, $0) })
                        ) {
                            (Text(verbatim: m.author + ": ").fontWeight(.semibold).foregroundStyle(Theme.ink)
                                + Text(verbatim: m.text).foregroundStyle(Theme.muted))
                                .font(.system(size: 12)).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        }
                        .toggleStyle(.checkbox)
                    }
                }
            }
            .frame(maxHeight: 260)
        }
        .padding(12).frame(width: 320)
    }
}
