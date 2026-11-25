import SqueakIcons
import SqueakMacCore
import SwiftUI

// The composer (draft A): "Message <Pond>, or @ a duck…", an @ picker for a duck or a person, Return sends, Shift-Return
// starts a line. To a duck it is that chat's own send path (PondRoomView.sendTo); to the room it is a room message.

struct RoomComposer: View {
    @Bindable var room: PondRoomModel
    let pondName: String
    /// Where it goes, the words and the attachments; answers a sentence when it could not be prepared (nothing sent).
    let send: (RoomAddressee, String, [OutgoingAttachment]) -> String?
    @Environment(AppModel.self) private var model
    @State private var dictation = DictationController()
    @State private var to: RoomAddressee = .everyone
    @State private var contentHeight: CGFloat = 0
    @State private var caret = 0
    @State private var highlighted = 0
    @State private var pickerDirection: SuggestionPlacement.Direction = .up
    @State private var chooser = false
    @State private var focused = false
    @State private var focusToken = 0
    @State private var fieldHandle = ComposerFieldHandle()

    private var people: [String] {
        let me = NSFullUserName()
        let names = PondsModel.shared.homeProject.flatMap { PondsModel.shared.detail(key: $0) }?.members.filter { !$0.you }.map(\.name) ?? []
        return names.filter { $0 != me }
    }

    private var draft: String { room.draft }
    private var mention: RoomMention.Active? { RoomMention.active(in: draft) }
    private var candidates: [RoomMention.Candidate] {
        mention.map { RoomMention.candidates(query: $0.query, threads: room.feed.threads, people: people) } ?? []
    }
    /// Window x of the typed `@`: the list opens from it.
    private var mentionX: CGFloat? {
        mention.flatMap { fieldHandle.windowX(ofCharacterAt: draft.utf16.distance(from: draft.startIndex, to: $0.range.lowerBound)) }
    }
    /// The shared placement: above the field's own top edge, from the `@`, best match nearest it, scrolling past six rows.
    private func withMentionList<V: View>(_ box: V) -> some View {
        box.suggestionPopup(
            isPresented: mention != nil && !candidates.isEmpty, direction: $pickerDirection, selected: highlighted,
            triggerX: mentionX, rowHeight: 38
        ) {
            picker(candidates, chrome: false)
        }
    }
    private var tray: RoomAttachmentTray { room.tray }
    private var canSend: Bool { tray.draft.canSend(text: draft) && !dictation.isActive }

    var body: some View {
        Group { if MacLayoutPreference.shared.isNew { newBox } else { oldBox } }
        .onChange(of: room.replyFocusToken) {
            to = .everyone
            chooser = false
            focusToken += 1
        }
        .onChange(of: mention?.query) { highlighted = 0 }
        .onChange(of: room.projectId, initial: true) { oldID, newID in
            if oldID != newID { dictation.cancel() }
            // Dictation is the chat composer's: the words land in the field for review, nothing is sent.
            dictation.onText = { words in
                room.draft = DictationState.append(words, to: draft)
                focusToken += 1
            }
        }
        .onDisappear { dictation.cancel() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakAttach)) { _ in tray.pick() }
        .accessibilityElement(children: .contain)
    }

    private var oldBox: some View { withMentionList(oldBoxContent) }

    private var oldBoxContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoomAttachmentStrip(tray: tray).padding(.top, 8)
            if dictation.state.showsMeter {
                DictationBar(dictation: dictation).padding(.top, 8)
            } else {
                ComposerField(
                    text: $room.draft, sendKey: .returnSends, placeholder: "Message \(pondName), or @ a duck\u{2026}",
                    focusToken: focusToken,
                    onSend: submit, onContentHeight: { contentHeight = $0 },
                    onImages: { tray.addImages($0) }, onFiles: { tray.add($0) }, onPickerKey: pickerKey, handle: fieldHandle, onFocus: { focused = $0 }
                )
                .frame(height: min(max(contentHeight, 24), 140)).padding(.top, 12).padding(.bottom, 4)
            }
            DictationNotice(dictation: dictation)
            bar
    }
    .padding(.horizontal, 14).padding(.bottom, 10)
    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(focused ? Theme.lineStrong : Theme.line))
    }

    // MARK: New layout (DESIGN.md §8.12, stage 3): the same field as the chat composer

    private var newBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            chipLine
            VStack(alignment: .leading, spacing: 4) {
                RoomAttachmentStrip(tray: tray).padding(.leading, 4)
                if let reply = room.reply { quoteBlock(reply.quote) }
                HStack(alignment: .bottom, spacing: 4) {
                    HStack(spacing: 0) {
                        RoomAttachButton(tray: tray)
                        Button { chooser.toggle() } label: {
                            Text(verbatim: "@").font(.system(size: 15, weight: .medium, design: .rounded)).foregroundStyle(Theme.muted)
                                .frame(width: 28, height: 28).contentShape(Circle())
                        }
                        .buttonStyle(.plain).pointerHand().accessibilityLabel("Choose who this goes to").help("Send to a duck or a person")
                        .popover(isPresented: $chooser, arrowEdge: .top) {
                            picker(RoomMention.candidates(query: "", threads: room.feed.threads, people: people), everyone: true)
                        }
                        micButton
                    }
                    .frame(height: 32)
                    if dictation.state.showsMeter {
                        DictationBar(dictation: dictation).frame(minHeight: 32)
                    } else {
                        ComposerField(
                            text: $room.draft, sendKey: .returnSends, placeholder: "Message \(pondName), or @ a duck\u{2026}",
                            focusToken: focusToken,
                            moveCaretToEndOnFocus: room.reply != nil,
                            onSend: submit, onContentHeight: { contentHeight = $0 },
                            onImages: { tray.addImages($0) }, onFiles: { tray.add($0) }, onPickerKey: pickerKey, handle: fieldHandle, onFocus: { focused = $0 }
                        )
                        .frame(height: min(max(contentHeight, 32), 140))
                    }
                    Button(action: submit) { DuckSendDisc(enabled: canSend) }
                        .buttonStyle(.plain).disabled(!canSend).accessibilityLabel("Send").frame(height: 32)
                }
                DictationNotice(dictation: dictation)
            }
            .padding(8)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(focused ? Theme.lineStrong : Theme.lineStrong.opacity(0.7)))
            .suggestionPopup(
                isPresented: mention != nil && !candidates.isEmpty, direction: $pickerDirection, selected: highlighted,
                triggerX: mentionX, rowHeight: 38
            ) {
                picker(candidates, chrome: false)
            }
        }
    }

    private func quoteBlock(_ quote: String) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1).fill(Theme.lineStrong).frame(width: 2, height: 16)
                .accessibilityHidden(true)
            Text(verbatim: quote)
                .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Quoted message: \(quote)")
            Button {
                room.reply = nil
                focusToken += 1
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.muted)
                    .frame(width: 24, height: 24).contentShape(Circle())
            }
            .buttonStyle(.plain).pointerHand().help("Remove quote").accessibilityLabel("Remove quote")
        }
        .padding(.horizontal, 6)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
    }

    /// Above the field: who it goes to ("Room \u{00B7} everyone", or the duck or person picked), tappable to change.
    private var chipLine: some View {
        HStack(spacing: 8) {
            Button { chooser.toggle() } label: {
                HStack(spacing: 6) {
                    if case .thread(let id, _) = to { ThreadDuckView(id: id, agent: room.feed.threads.first { $0.sessionId == id }?.agent, size: 14) }
                    Text(verbatim: to == .everyone ? "Room \u{00B7} everyone" : "To \(to.label)").font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.ink).lineLimit(1)
                    Lucide(.chevronDown, size: 11, color: Theme.muted)
                }
                .padding(.horizontal, 10).frame(minHeight: 26).contentShape(Capsule())
            }
            .buttonStyle(.plain).pointerHand()
            .background(Theme.sidebar, in: Capsule()).overlay(Capsule().strokeBorder(Theme.line))
            .accessibilityLabel(to == .everyone ? "Sending to everyone in the room. Press to choose who" : "Sending to \(to.label). Press to choose who")
            if to != .everyone {
                Button { to = .everyone } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.muted).frame(width: 22, height: 22).contentShape(Circle()) }
                    .buttonStyle(.plain).pointerHand().accessibilityLabel("Send to the whole pond instead")
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 6).frame(height: 28)
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

    /// `chrome: false` is the inline list (the suggestion popup draws its own frame); the "@" button's popover keeps its own.
    @ViewBuilder
    private func picker(_ list: [RoomMention.Candidate], everyone: Bool = false, chrome: Bool = true) -> some View {
        let rows = Array(list.prefix(8).enumerated())
        let drawn = everyone ? rows : SuggestionPlacement.drawOrder(count: rows.count, direction: pickerDirection).map { rows[$0] }
        let body = VStack(alignment: .leading, spacing: 0) {
            if everyone { row(.init(id: "all", addressee: .everyone, subtitle: "Everyone in the room"), index: -1) }
            ForEach(drawn, id: \.element.id) { i, c in row(c, index: everyone ? -1 : i).id(i) }
        }
        .padding(6).frame(width: chrome ? 300 : nil)
        if chrome {
            body
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
        } else {
            body.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func row(_ c: RoomMention.Candidate, index: Int) -> some View {
        Button { choose(c) } label: {
            HStack(spacing: 8) {
                if case .thread(let id, _) = c.addressee { ThreadDuckView(id: id, agent: room.feed.threads.first { $0.sessionId == id }?.agent, size: 18) }
                else { Lucide(.messageSquare, size: 14, color: Theme.muted).frame(width: 18) }
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: c.addressee.label).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: c.subtitle).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(maxWidth: .infinity).frame(height: 38)
            .background(index == highlighted ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(c.addressee.label + ", " + c.subtitle)
    }

    private func choose(_ c: RoomMention.Candidate) {
        if let insertion = c.insertion {
            // An Off-duty Duck: the mention goes into the message (the host wakes it and gives it a fresh name).
            var d = draft
            if let m = mention { d.replaceSubrange(m.range, with: insertion) }
            else { d += (d.isEmpty || d.hasSuffix(" ") ? "" : " ") + insertion }
            room.draft = d
            chooser = false
            highlighted = 0
            return
        }
        if let m = mention { room.draft = RoomMention.removing(m, from: draft) }
        to = c.addressee
        chooser = false
        highlighted = 0
    }

    private func pickerKey(_ key: ComposerPickerKey) -> Bool {
        guard mention != nil else { return false }
        let list = Array(candidates.prefix(8))
        guard !list.isEmpty else { return false }
        switch key {
        case .up: highlighted = (highlighted + SuggestionPlacement.step(up: true, direction: pickerDirection) + list.count) % list.count
        case .down: highlighted = (highlighted + SuggestionPlacement.step(up: false, direction: pickerDirection) + list.count) % list.count
        case .accept: choose(list[min(highlighted, list.count - 1)])
        case .escape: if let m = mention { room.draft = RoomMention.removing(m, from: draft) }
        }
        return true
    }

    private func submit() {
        guard canSend else { return }
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let reply = MacLayoutPreference.shared.isNew ? room.reply : nil
        let text = reply?.messageText(body) ?? body
        let items = tray.items
        if let problem = send(to, text, items) { tray.fail(problem); return }
        room.draft = ""
        room.reply = nil
        tray.clear()
    }
}
