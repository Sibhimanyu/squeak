import SqueakIcons
import SqueakMacCore
import SwiftUI

// The composer: "To [Everyone v]", an @ picker for a thread or a person, Return sends, Shift-Return starts a line.
// To a thread it is that chat's own send path (RoomView.sendTo); to Everyone it is a room message.

struct RoomComposer: View {
    let room: PondRoomModel
    let send: (RoomAddressee, String) -> Void
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var to: RoomAddressee = .everyone
    @State private var contentHeight: CGFloat = 0
    @State private var caret = 0
    @State private var highlighted = 0
    @State private var chooser = false
    @State private var focused = false

    private var people: [String] {
        let me = NSFullUserName()
        let names = PondsModel.shared.homeProject.flatMap { PondsModel.shared.detail(key: $0) }?.members.filter { !$0.you }.map(\.name) ?? []
        return names.filter { $0 != me }
    }

    private var mention: RoomMention.Active? { RoomMention.active(in: draft) }
    private var candidates: [RoomMention.Candidate] {
        mention.map { RoomMention.candidates(query: $0.query, threads: room.feed.threads, people: people) } ?? []
    }
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            addressRow
            ComposerField(
                text: $draft, sendKey: .returnSends, placeholder: "Message the pond, or type @ to steer a thread",
                onSend: submit, onContentHeight: { contentHeight = $0 }, onPickerKey: pickerKey, onFocus: { focused = $0 }
            )
            .frame(height: min(max(contentHeight, 30), 140)).padding(.horizontal, 10)
            hintsRow
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(focused ? Theme.lineStrong : Theme.line))
        .overlay(alignment: .bottomLeading) {
            if mention != nil, !candidates.isEmpty { picker(candidates).offset(y: -(contentHeight + 56)).padding(.leading, 12) }
        }
        .onChange(of: mention?.query) { highlighted = 0 }
        .accessibilityElement(children: .contain)
    }

    private var addressRow: some View {
        HStack(spacing: 8) {
            Text("To").font(.system(size: 13)).foregroundStyle(Theme.subtle)
            Button { chooser.toggle() } label: {
                HStack(spacing: 6) {
                    if case .thread(let id, _) = to { ThreadDuckView(id: id, agent: room.feed.threads.first { $0.sessionId == id }?.agent, size: 16) }
                    Text(verbatim: to.label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 8).frame(height: 24).background(Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Send to \(to.label)").accessibilityHint("Choose who this goes to")
            .popover(isPresented: $chooser, arrowEdge: .top) {
                picker(RoomMention.candidates(query: "", threads: room.feed.threads, people: people), everyone: true)
            }
            if to == .everyone {
                Text("Press @ to pick a thread or a person").font(.system(size: 13)).foregroundStyle(Theme.subtle).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.top, 10)
    }

    private var hintsRow: some View {
        HStack(spacing: 14) {
            hint("@", "thread"); hint("Return", "send"); hint("Shift Return", "new line")
            Spacer(minLength: 0)
            Button(action: submit) {
                Lucide(.arrowUp, size: 16, color: canSend ? Theme.primaryText : Theme.muted)
                    .frame(width: 28, height: 28)
                    .background(canSend ? Theme.primaryFill : Theme.selected, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain).disabled(!canSend).accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.bottom, 10).padding(.top, 4)
    }

    private func hint(_ key: String, _ word: String) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: key).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                .padding(.horizontal, 6).frame(height: 18).background(Theme.selected, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            Text(verbatim: word).font(.system(size: 12)).foregroundStyle(Theme.subtle)
        }
        .accessibilityElement(children: .combine)
    }

    private func picker(_ list: [RoomMention.Candidate], everyone: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if everyone { row(.init(id: "all", addressee: .everyone, subtitle: "The whole pond"), index: -1) }
            ForEach(Array(list.prefix(8).enumerated()), id: \.element.id) { i, c in row(c, index: everyone ? -1 : i) }
        }
        .padding(6).frame(width: 300)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
    }

    private func row(_ c: RoomMention.Candidate, index: Int) -> some View {
        Button { choose(c.addressee) } label: {
            HStack(spacing: 8) {
                if case .thread(let id, _) = c.addressee { ThreadDuckView(id: id, agent: room.feed.threads.first { $0.sessionId == id }?.agent, size: 18) }
                else { Lucide(.messageSquare, size: 14, color: Theme.muted).frame(width: 18) }
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: c.addressee.label).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: c.subtitle).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 38)
            .background(index == highlighted ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(c.addressee.label + ", " + c.subtitle)
    }

    private func choose(_ a: RoomAddressee) {
        if let m = mention { draft = RoomMention.removing(m, from: draft) }
        to = a
        chooser = false
        highlighted = 0
    }

    private func pickerKey(_ key: ComposerPickerKey) -> Bool {
        guard mention != nil else { return false }
        let list = Array(candidates.prefix(8))
        guard !list.isEmpty else { return false }
        switch key {
        case .up: highlighted = (highlighted - 1 + list.count) % list.count
        case .down: highlighted = (highlighted + 1) % list.count
        case .accept: choose(list[min(highlighted, list.count - 1)].addressee)
        case .escape: if let m = mention { draft = RoomMention.removing(m, from: draft) }
        }
        return true
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        send(to, text)
    }
}
