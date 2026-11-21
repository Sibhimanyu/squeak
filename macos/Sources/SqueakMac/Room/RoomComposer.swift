import SqueakIcons
import SqueakMacCore
import SwiftUI

// The composer (draft A): "Message <Pond>, or @ a duck…", an @ picker for a duck or a person, Return sends, Shift-Return
// starts a line. To a duck it is that chat's own send path (PondRoomView.sendTo); to the room it is a room message.

struct RoomComposer: View {
    let room: PondRoomModel
    let pondName: String
    /// Where it goes, the words and the attachments; answers a sentence when it could not be prepared (nothing sent).
    let send: (RoomAddressee, String, [OutgoingAttachment]) -> String?
    @Environment(AppModel.self) private var model
    @State private var dictation = DictationController()
    @State private var draft = ""
    @State private var to: RoomAddressee = .everyone
    @State private var contentHeight: CGFloat = 0
    @State private var caret = 0
    @State private var highlighted = 0
    @State private var chooser = false
    @State private var focused = false
    @State private var focusToken = 0

    private var people: [String] {
        let me = NSFullUserName()
        let names = PondsModel.shared.homeProject.flatMap { PondsModel.shared.detail(key: $0) }?.members.filter { !$0.you }.map(\.name) ?? []
        return names.filter { $0 != me }
    }

    private var draftKey: String { ContainerDrafts.room(room.projectId) }
    private var mention: RoomMention.Active? { RoomMention.active(in: draft) }
    private var candidates: [RoomMention.Candidate] {
        mention.map { RoomMention.candidates(query: $0.query, threads: room.feed.threads, people: people) } ?? []
    }
    private var tray: RoomAttachmentTray { room.tray }
    private var canSend: Bool { tray.draft.canSend(text: draft) && !dictation.isActive }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoomAttachmentStrip(tray: tray).padding(.top, 8)
            if dictation.state.showsMeter {
                DictationBar(dictation: dictation).padding(.top, 8)
            } else {
                ComposerField(
                    text: $draft, sendKey: .returnSends, placeholder: "Message \(pondName), or @ a duck\u{2026}",
                    focusToken: focusToken,
                    onSend: submit, onContentHeight: { contentHeight = $0 },
                    onImages: { tray.addImages($0) }, onFiles: { tray.add($0) }, onPickerKey: pickerKey, onFocus: { focused = $0 }
                )
                .frame(height: min(max(contentHeight, 24), 140)).padding(.top, 12).padding(.bottom, 4)
            }
            DictationNotice(dictation: dictation)
            bar
        }
        .padding(.horizontal, 14).padding(.bottom, 10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(focused ? Theme.lineStrong : Theme.line))
        .overlay(alignment: .topLeading) {
            // Anchored to the composer's own top edge (its measured top, whatever the attachment tray or dictation bar
            // hold): the picker's bottom sits a small gap above it, so it can never overlap them.
            if mention != nil, !candidates.isEmpty {
                picker(candidates).alignmentGuide(.top) { $0[.bottom] + 6 }.padding(.leading, 12)
            }
        }
        .onAppear { if draft.isEmpty { draft = ContainerDrafts.shared.draft(for: draftKey) } }
        .onChange(of: draftKey) { _, key in draft = ContainerDrafts.shared.draft(for: key) }
        .onChange(of: draft) { _, text in ContainerDrafts.shared.set(text, for: draftKey) }
        .onChange(of: mention?.query) { highlighted = 0 }
        .onAppear {
            // Dictation is the chat composer's: the words land in the field for review, nothing is sent.
            dictation.onText = { words in
                draft = DictationState.append(words, to: draft)
                focusToken += 1
            }
        }
        .onChange(of: room.projectId) { _, _ in dictation.cancel() }
        .onDisappear { dictation.cancel() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakAttach)) { _ in tray.pick() }
        .accessibilityElement(children: .contain)
    }

    private var bar: some View {
        HStack(spacing: 8) {
            Button { chooser.toggle() } label: {
                Image(systemName: "at").font(.system(size: 14)).foregroundStyle(Theme.subtle).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Choose who this goes to").help("Send to a duck or a person")
            .popover(isPresented: $chooser, arrowEdge: .top) {
                picker(RoomMention.candidates(query: "", threads: room.feed.threads, people: people), everyone: true)
            }
            if to != .everyone {
                HStack(spacing: 6) {
                    if case .thread(let id, _) = to { ThreadDuckView(id: id, agent: room.feed.threads.first { $0.sessionId == id }?.agent, size: 14) }
                    Text(verbatim: "To \(to.label)").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Button { to = .everyone } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.muted) }
                        .buttonStyle(.plain).accessibilityLabel("Send to the whole pond instead")
                }
                .padding(.horizontal, 8).frame(height: 22).background(Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            Spacer(minLength: 0)
            RoomAttachButton(tray: tray)
            micButton
            Button(action: submit) {
                Lucide(.arrowUp, size: 14, color: canSend ? Theme.primaryText : Theme.ink)
                    .frame(width: 26, height: 26).background(canSend ? Theme.primaryFill : Theme.selectedStrong, in: Circle())
            }
            .buttonStyle(.plain).disabled(!canSend).accessibilityLabel("Send")
        }
    }

    /// The chat composer's mic: same controller, bars, notice and settings; words go to the field for review.
    private var micButton: some View {
        Button { dictation.toggle() } label: {
            Lucide(.mic, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(dictation.isActive)
        .keyboardShortcut("d", modifiers: [.command, .shift])
        .shortcutHint("Dictate", .dictate)
        .accessibilityLabel("Dictate a message")
    }

    private func picker(_ list: [RoomMention.Candidate], everyone: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if everyone { row(.init(id: "all", addressee: .everyone, subtitle: "Everyone in the room"), index: -1) }
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
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let items = tray.items
        if let problem = send(to, text, items) { tray.fail(problem); return }
        draft = ""
        ContainerDrafts.shared.clear(draftKey)
        tray.clear()
    }
}
