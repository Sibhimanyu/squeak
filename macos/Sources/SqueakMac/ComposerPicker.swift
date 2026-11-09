import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Where the composer's pickers read from: the chat's folder (for `@`) and its commands (for `/`).
struct ComposerPickerSource {
    var folder: String?
    var commands: (@Sendable () async -> [SlashCommand])?
    /// Changes when the sources do (another chat), so cached lists are dropped.
    var identity: String
}

struct ComposerPickItem: Identifiable, Equatable {
    var id: String
    var title: String
    var detail: String
}

/// The open picker: what the caret is in, the ranked rows and the highlighted one. Lists load once per chat
/// (files also sit in `WorkspaceFileIndex`'s 30 s cache) and are matched here as the person types.
@MainActor @Observable
final class ComposerPickerModel {
    private(set) var trigger: ComposerTrigger?
    private(set) var items: [ComposerPickItem] = []
    private(set) var loading = false
    var selected = 0
    @ObservationIgnored private var dismissed: NSRange?
    @ObservationIgnored private var files: [String]?
    @ObservationIgnored private var commands: [SlashCommand]?
    @ObservationIgnored private var loadedFor = ""
    @ObservationIgnored private var source: ComposerPickerSource?
    @ObservationIgnored private var lastText = ""
    @ObservationIgnored private var lastCaret = 0

    var isOpen: Bool { trigger != nil && (!items.isEmpty || loading) }

    func use(_ source: ComposerPickerSource?) {
        self.source = source
        let id = source?.identity ?? ""
        if id != loadedFor { loadedFor = id; files = nil; commands = nil; trigger = nil; items = []; dismissed = nil }
    }

    func refresh(text: String, caret: Int) {
        lastText = text; lastCaret = caret
        guard source != nil, let t = ComposerTrigger.detect(in: text, caret: caret), t.range != dismissed else {
            if ComposerTrigger.detect(in: text, caret: caret) == nil { dismissed = nil }
            trigger = nil; items = []; return
        }
        trigger = t
        switch t {
        case .mention(let q, _):
            guard let files else { load(files: true); return }
            items = FuzzyMatch.rank(q, files, limit: 8, key: { $0 }).map {
                ComposerPickItem(id: $0, title: $0, detail: "")
            }
        case .command(let q, _):
            guard let commands else { load(files: false); return }
            items = FuzzyMatch.rank(q, commands, limit: 8, key: { $0.name }).map {
                ComposerPickItem(id: $0.name, title: "/" + $0.name, detail: $0.detail)
            }
        }
        selected = min(selected, max(items.count - 1, 0))
        if items.isEmpty { selected = 0 }
    }

    private func load(files wantsFiles: Bool) {
        guard !loading, let source else { return }
        loading = true
        let id = loadedFor
        Task {
            if wantsFiles {
                var found: [String] = []
                if let folder = source.folder, !folder.isEmpty { found = await WorkspaceFileIndex.shared.files(in: folder) }
                if id == loadedFor { files = found }
            } else {
                let found = await source.commands?() ?? []
                if id == loadedFor { commands = found }
            }
            loading = false
            refresh(text: lastText, caret: lastCaret)
        }
    }

    func move(_ delta: Int) {
        guard !items.isEmpty else { return }
        selected = (selected + delta + items.count) % items.count
    }

    func dismiss() {
        dismissed = trigger?.range
        trigger = nil; items = []
    }

    /// The text that replaces the trigger's word, and that range.
    func choice(at index: Int) -> (range: NSRange, text: String)? {
        guard let trigger, items.indices.contains(index) else { return nil }
        switch trigger {
        case .mention: return (trigger.range, "@" + items[index].id + " ")
        case .command: return (trigger.range, "/" + items[index].id + " ")
        }
    }
}

/// The list above the composer: path or command in `code`, its description in `muted`; ↑↓ ↵ esc work from the
/// field and a click picks a row. Drawn inside the window (not an NSPopover) so the field keeps the keyboard.
struct ComposerPickerList: View {
    let model: ComposerPickerModel
    let onPick: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.items.isEmpty {
                Text(verbatim: "Loading…").font(Typo.meta).foregroundStyle(Theme.muted).padding(10)
            }
            ForEach(Array(model.items.enumerated()), id: \.element.id) { i, item in
                Button { onPick(i) } label: {
                    HStack(spacing: 8) {
                        Lucide(model.trigger.map { if case .mention = $0 { true } else { false } } == true ? .fileText : .terminal,
                               size: 13, color: Theme.muted)
                        Text(verbatim: item.title).font(Typo.code).foregroundStyle(Theme.ink)
                            .lineLimit(1).truncationMode(.head)
                        if !item.detail.isEmpty {
                            Text(verbatim: item.detail).font(Typo.meta).foregroundStyle(Theme.muted)
                                .lineLimit(1).truncationMode(.tail).layoutPriority(-1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(i == model.selected ? Theme.surfaceRaised : .clear,
                                in: RoundedRectangle(cornerRadius: Radius.chip))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .frame(maxWidth: 520, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.lineStrong))
        .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestions")
    }
}
