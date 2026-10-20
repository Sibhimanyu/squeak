import AppKit
import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// The reading side of the quick message pill: the reply a notification (or an explicit open of a
/// chat) is about. It loads on its own, apart from the conversation window's focus, and a load
/// belongs to the chat and show it began under: hiding or retargeting the pill drops it, so a slow
/// read can never paint one chat's reply over another's.
@MainActor @Observable
final class QuickContextModel {
    enum Phase: Equatable {
        case hidden
        case loading
        /// `extra` is what this read adds to the content's own note (offline, chat gone).
        case ready(NotificationContextContent, extra: String?)
        case failed(String)
    }

    private(set) var phase: Phase = .hidden
    private(set) var key: SessionKey?
    private(set) var anchor: NotificationAnchor?
    private(set) var fromNotification = false
    var showEarlier = false
    var expanded = false
    /// Why "Open in Conductor" did nothing, shown under the status row. Cleared with the context.
    var openNotice: String?
    /// Changes whenever the context is cleared, reloaded or retargeted, so an action that finishes
    /// later can tell it belongs to an older one and leave the new one alone.
    @ObservationIgnored private(set) var serial = 0
    @ObservationIgnored private var gate = ContextLoadGate()
    @ObservationIgnored private var task: Task<Void, Never>?

    var isVisible: Bool { phase != .hidden }

    /// What the shown reply covers, waiting for the view to report it drawn.
    struct PendingRead: Equatable {
        var key: SessionKey
        var eventId: String?
        var through: Date
    }
    private(set) var pendingRead: PendingRead?

    /// Called by the view once a valid reply is on screen. Only a read that began under the current
    /// load and chat counts, and it reads nothing newer than what was displayed.
    func commitRead(model: AppModel) {
        guard case .ready(let c, _) = phase, c.response != nil, let p = pendingRead, p.key == key else { return }
        pendingRead = nil
        model.markContextDisplayed(p.key, eventId: p.eventId, through: p.through)
    }

    /// Drops the context and invalidates any load still running.
    func clear() {
        serial += 1
        openNotice = nil
        pendingRead = nil
        gate.invalidate()
        task?.cancel()
        task = nil
        phase = .hidden
        key = nil
        anchor = nil
        fromNotification = false
        showEarlier = false
        expanded = false
    }

    func load(key: SessionKey, anchor: NotificationAnchor?, fromNotification: Bool, model: AppModel) {
        clear()
        self.key = key
        self.anchor = anchor
        self.fromNotification = fromNotification
        phase = .loading
        let token = gate.begin(key: key, eventId: anchor?.eventId)
        task = Task { [weak self] in
            await self?.run(token, key: key, anchor: anchor, fromNotification: fromNotification, model: model)
        }
    }

    /// Shows fixed content with no load, for screenshots of the pill. Nothing is read or marked.
    func preview(key: SessionKey, anchor: NotificationAnchor?, content: NotificationContextContent) {
        clear()
        self.key = key
        self.anchor = anchor
        phase = .ready(content, extra: nil)
    }

    func retry(model: AppModel) {
        guard let key else { return }
        load(key: key, anchor: anchor, fromNotification: fromNotification, model: model)
    }

    private func run(_ token: ContextLoadGate.Token, key: SessionKey, anchor: NotificationAnchor?, fromNotification: Bool, model: AppModel) async {
        let resolved = model.resolvedAnchor(anchor)
        func pick(_ messages: [ChatMessage]) -> NotificationContextContent {
            NotificationContextPolicy.resolve(messages: messages, anchor: resolved, fromNotification: fromNotification, now: Date())
        }
        let cached = await model.cachedContextMessages(for: key)
        guard gate.accepts(token) else { return }
        // A reply the notification itself pinned is as good from the cache as from the chat.
        var shown: NotificationContextContent?
        let first = pick(cached)
        if first.response != nil, first.confidence == .exact || first.confidence == .atOrBeforeEvent {
            shown = first
            phase = .ready(first, extra: nil)
            if let at = resolved?.at { pendingRead = PendingRead(key: key, eventId: resolved?.eventId, through: at) }
        }
        switch await model.liveContextMessages(for: key) {
        case .messages(let live, let fetchedAt):
            guard gate.accepts(token) else { return }
            let content = pick(NotificationContextPolicy.merge(cached: cached, live: live))
            guard content.response != nil else {
                phase = .failed(content.note ?? "There is no message to show.")
                return
            }
            phase = .ready(content, extra: nil)
            await model.rememberContext(content, for: key)
            guard gate.accepts(token) else { return }
            // Read once the view has drawn it: up to the event's own time when it was pinned, else up to the read.
            let through = content.confidence == .latestAvailable ? fetchedAt : (resolved?.at ?? fetchedAt)
            pendingRead = PendingRead(key: key, eventId: content.confidence == .latestAvailable ? nil : resolved?.eventId, through: through)
        case .sessionGone:
            guard gate.accepts(token) else { return }
            if let shown {
                phase = .ready(shown, extra: "This chat is no longer available, so this is the saved copy.")
            } else {
                phase = .failed("This chat is no longer available, so its message can't be shown.")
            }
        case .offline:
            guard gate.accepts(token) else { return }
            if let shown {
                phase = .ready(shown, extra: "Squeak can't reach the service right now, so this is the saved copy.")
            } else if first.response != nil {
                phase = .ready(first, extra: "Squeak can't reach the service right now, so this may not be the newest message.")
            } else {
                phase = .failed("Squeak can't reach the service right now, so the message can't be loaded.")
            }
        case .failed:
            guard gate.accepts(token) else { return }
            if let shown {
                phase = .ready(shown, extra: "Couldn't refresh this chat, so this is the saved copy.")
            } else if first.response != nil {
                phase = .ready(first, extra: "Couldn't refresh this chat, so this may not be the newest message.")
            } else {
                phase = .failed("Couldn't read this chat's messages.")
            }
        }
    }
}

/// Context above the composer's own field, in the same glass: status line, task, the reply as
/// selectable text, and a collapsed disclosure for the request and earlier messages of the turn.
struct QuickContextView: View {
    let context: QuickContextModel
    let session: HostSession?
    let key: SessionKey
    /// The most height the scrolling part may take (`QuickLayout.contextLimit`): the status row
    /// stays pinned above it, and everything under that scrolls as one region.
    let maxHeight: CGFloat
    var close: () -> Void
    @Environment(AppModel.self) private var model
    @State private var responseNatural: CGFloat = 0

    /// Collapsed height of the reply: readable, never most of the screen.
    private static let collapsedLimit: CGFloat = 170
    private var overflows: Bool { responseNatural > Self.collapsedLimit + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusRow.padding(.bottom, context.openNotice == nil ? 8 : 2)
            if let notice = context.openNotice {
                Text(verbatim: notice).font(.system(size: 11)).foregroundStyle(Theme.muted).padding(.bottom, 6)
            }
            // One scroll path for the whole reading side: it shrink-wraps a short reply and scrolls a
            // long one (or both disclosures open) instead of pushing the field off the screen.
            MeasuredScroll(limit: maxHeight, scrolls: true, fadesBottom: false) {
                VStack(alignment: .leading, spacing: 0) {
                    titleBlock
                    switch context.phase {
                    case .hidden:
                        EmptyView()
                    case .loading:
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Loading the message…").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        }
                        .padding(.top, 12)
                    case .failed(let why):
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(verbatim: why).font(.system(size: 13)).foregroundStyle(Theme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                            if session != nil { Button("Retry") { context.retry(model: model) }.buttonStyle(.link).font(.system(size: 13)) }
                        }
                        .padding(.top, 12)
                    case .ready(let content, let extra):
                        ready(content, extra: extra).padding(.top, 12)
                    }
                }
            }
        }
        .onAppear { context.commitRead(model: model) }
        .onChange(of: context.pendingRead) { _, _ in context.commitRead(model: model) }
        .onChange(of: context.phase) { _, _ in context.commitRead(model: model) }
    }

    // MARK: Status and title

    private var statusRow: some View {
        let kind = context.anchor?.kind
        let line = ContextStatusLine.make(kind: kind)
        let date = readyDate
        return HStack(spacing: 8) {
            symbol(line.symbol)
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text(verbatim: [line.text, date.flatMap(Self.ago)].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            if key.provider == "conductor", let s = session, s.capabilities.openInHost.reason == nil {
                Button {
                    // Closes only if Conductor was really opened and this is still the same context:
                    // a composer retargeted meanwhile is left alone, and a failure keeps the draft.
                    let serial = context.serial
                    Task {
                        let opened = await model.openInHost(key)
                        guard context.serial == serial else { return }
                        if opened { close() } else { context.openNotice = "Conductor couldn't be opened from here." }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("Open in Conductor")
                        Lucide(.externalLink, size: 12, color: Theme.muted)
                    }
                    .font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open this chat in Conductor")
            }
            Button(action: close) {
                Lucide(.x, size: 14, color: Theme.muted).frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
    }

    /// When the reply this shows happened: the event's own time when the notification pinned it,
    /// the message's own time when it is only the latest.
    private var readyDate: Date? {
        if case .ready(let c, _) = context.phase {
            if c.confidence == .latestAvailable { return c.response?.at }
            return context.anchor?.at ?? c.response?.at
        }
        return context.anchor?.at
    }

    private static func ago(_ date: Date) -> String {
        if Date().timeIntervalSince(date) > 8 * 7 * 86400 { return ShortRelativeTime.format(date) }
        let s = ShortRelativeTime.format(date)
        return s == "now" ? "just now" : "\(s) ago"
    }

    @ViewBuilder private func symbol(_ s: ContextStatusLine.Symbol) -> some View {
        switch s {
        case .finished:
            ZStack {
                Circle().fill(Theme.done).frame(width: 16, height: 16)
                Lucide(.check, size: 10, color: .white)
            }
            .accessibilityHidden(true)
        case .error: Lucide(.circleAlert, size: 16, color: Theme.error).accessibilityHidden(true)
        case .attention: Lucide(.circleAlert, size: 16, color: Theme.needsYou).accessibilityHidden(true)
        case .plan: Lucide(.clipboardList, size: 16, color: Theme.needsYou).accessibilityHidden(true)
        case .neutral: Lucide(.messageSquare, size: 15, color: Theme.muted).accessibilityHidden(true)
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: session?.label ?? "Unavailable chat")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
            if let meta { Text(verbatim: meta).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1) }
        }
    }

    private var meta: String? {
        guard let s = session else { return nil }
        var place = [s.repoName, s.cwd.map { URL(fileURLWithPath: $0).lastPathComponent }].compactMap { $0 }.filter { !$0.isEmpty }
        if place.count == 2, place[0] == place[1] { place.removeLast() }
        let agent = s.agent.map { $0.prefix(1).uppercased() + $0.dropFirst() }
        let head = place.joined(separator: " / ")
        return [head.isEmpty ? nil : head, agent].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: Content

    @ViewBuilder private func ready(_ content: NotificationContextContent, extra: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let response = content.response {
                // Collapsed it is cut (and fades) at a readable height; expanded it takes its full
                // height and the context's own scroll region carries it.
                MeasuredScroll(limit: context.expanded ? .infinity : Self.collapsedLimit, scrolls: false, fadesBottom: !context.expanded && overflows,
                               onNatural: { responseNatural = $0 }) {
                    MessageText(markdown: response.text, style: .squeak).textSelection(.enabled)
                }
            }
            if let note = [content.note, extra].compactMap({ $0 }).joined(separator: " ").nilIfEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Lucide(.info, size: 12, color: Theme.muted).accessibilityHidden(true)
                    Text(verbatim: note).font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            if content.hasEarlier || overflows {
                HStack(spacing: 14) {
                    if content.hasEarlier {
                        disclosure(context.showEarlier ? "Hide earlier messages" : "Show earlier messages", expanded: context.showEarlier) {
                            context.showEarlier.toggle()
                        }
                    }
                    if overflows {
                        disclosure(context.expanded ? "Show less" : "Show more", expanded: context.expanded) { context.expanded.toggle() }
                    }
                    Spacer(minLength: 0)
                }
            }
            if context.showEarlier, content.hasEarlier { earlier(content) }
        }
    }

    private func disclosure(_ title: String, expanded: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(title)
                Lucide(expanded ? .chevronUp : .chevronRight, size: 12, color: Theme.link)
            }
            .font(.system(size: 12)).foregroundStyle(Theme.link)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    private func earlier(_ content: NotificationContextContent) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let request = content.request {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Your message").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                    Text(verbatim: request.text).font(.system(size: 13)).foregroundStyle(Theme.ink.opacity(0.85)).textSelection(.enabled)
                }
            }
            ForEach(content.earlier) { m in
                VStack(alignment: .leading, spacing: 3) {
                    Text("Earlier in this turn").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                    MessageText(markdown: m.text, style: .squeak).textSelection(.enabled).opacity(0.85)
                }
            }
        }
        .padding(.top, 2)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

private extension Theme {
    /// Quiet link colour for disclosures, matching the mockup's soft blue.
    static var link: Color { Theme.done }
}

/// A scroll view that shrink-wraps its content up to `limit`, reporting the content's natural
/// height. Collapsed content does not scroll and fades at the bottom so a cut-off line reads as cut.
private struct MeasuredScroll<Content: View>: View {
    var limit: CGFloat
    var scrolls: Bool
    var fadesBottom: Bool
    var onNatural: (CGFloat) -> Void = { _ in }
    @ViewBuilder var content: Content
    @State private var natural: CGFloat = 60

    private var shown: CGFloat { max(1, min(natural, limit)) }

    var body: some View {
        ScrollView(.vertical) {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(GeometryReader { Color.clear.preference(key: ContextHeightKey.self, value: $0.size.height) })
        }
        .scrollDisabled(!scrolls)
        .scrollIndicators(scrolls && natural > limit ? .automatic : .hidden)
        .onPreferenceChange(ContextHeightKey.self) { h in
            natural = h
            onNatural(h)
        }
        .frame(height: shown)
        .mask {
            if fadesBottom {
                VStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 28)
                }
            } else {
                Rectangle()
            }
        }
        // This instance reads its own content above, then stops the height from escaping. Without it an
        // inner reply's full, un-clipped height reaches an enclosing MeasuredScroll's reduce and inflates it.
        .transformPreference(ContextHeightKey.self) { $0 = 0 }
    }
}

private struct ContextHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
