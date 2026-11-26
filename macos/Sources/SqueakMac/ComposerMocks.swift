import SqueakIcons
import SqueakMacCore
import SwiftUI

// Composer redesign mocks (owner review, 2026-11-26). Drawn only by `SqueakMac --snapshots` (Snapshots.swift); nothing in the
// live window uses them. Two directions, from plain data, so whichever is chosen can replace `ChatComposerBox`,
// `DucklingsBar` and the chip line in place:
//   A, unified card: ducklings are a status line in the card's top edge; model, mode and every tool sit in one bottom toolbar.
//   B, attached tray: the message box is the hero; ducklings and the model share one tray fused to its top edge.
// Long text: the text area grows one 22pt line at a time up to eight lines (`ComposerDesign.growth`), then scrolls inside
// under a soft top fade; the toolbar is a fixed 36pt row pinned to the box's bottom edge, so no icon ever moves.

/// What a mock composer shows.
struct ComposerMockState {
    var duck = "Pickle"
    var model = "Opus 5.5 1M"
    var effort = "Medium"
    var mode: ComposerMode = .skipApprovals
    var ducklings: [Duckling] = []
    /// The agent's turn is open.
    var working = false
    /// The current step while working ("editing auth.ts").
    var step: String?
    var text = ""
    var contextUsed = 38.0

    var running: Int { ducklings.filter { $0.status == .running }.count }
    var placeholder: String { working ? "Add a follow-up. \(duck) reads it after this turn" : "Message \(duck)" }
    var lines: Int { text.isEmpty ? 1 : ComposerMock.estimatedLines(text) }
}

enum ComposerMock {
    static let lineHeight = 22.0
    static let toolbar: CGFloat = 36
    static let fieldInset = 12.0
    /// Characters per line at 14pt in a ~700pt field, for the mock's growth only (the real field measures its text).
    static func estimatedLines(_ text: String) -> Int {
        text.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) { $0 + max(1, Int((Double($1.count) / 96).rounded(.up))) }
    }

    static let maxLines = 8
    static func growth(_ s: ComposerMockState) -> ComposerDesign.Growth {
        ComposerDesign.growth(lines: s.lines, lineHeight: lineHeight, minLines: 1, maxLines: maxLines, inset: fieldInset)
    }
}

// MARK: Shared pieces

/// The text area: placeholder or the text at 14/22. Past the maximum it shows its last lines (the caret is at the end)
/// under a soft fade at the top and a slim scroller, as the real NSTextView scrolls.
private struct MockTextArea: View {
    let state: ComposerMockState
    var trailingHint: String? = "\u{2318}L"

    var body: some View {
        let g = ComposerMock.growth(state)
        ZStack(alignment: .topLeading) {
            if state.text.isEmpty {
                HStack {
                    Text(verbatim: state.placeholder).foregroundStyle(Theme.subtle)
                    Spacer(minLength: 8)
                    if let trailingHint { Text(verbatim: trailingHint).font(.system(size: 11)).foregroundStyle(Theme.subtle) }
                }
                .font(.system(size: 14)).lineSpacing(0)
                .padding(.vertical, 6)
            } else {
                Text(verbatim: state.text)
                    .font(.system(size: 14)).foregroundStyle(Theme.ink)
                    .lineSpacing(ComposerMock.lineHeight - 17)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
                    .frame(height: g.height, alignment: g.scrolls ? .bottom : .top)
                    .clipped()
                    .mask {
                        if g.scrolls {
                            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.16)],
                                           startPoint: .top, endPoint: .bottom)
                        } else { Rectangle() }
                    }
            }
        }
        .frame(height: g.height, alignment: .top)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topTrailing) {
            if g.scrolls {
                // Scrolled to the end: a slim thumb at the bottom of a quiet track.
                Capsule().fill(Theme.lineStrong).frame(width: 4, height: g.height * 0.32)
                    .frame(height: g.height - 8, alignment: .bottom).padding(.top, 4).offset(x: 6)
            }
        }
    }
}

/// A 28pt quiet icon button (attach, mic).
private struct MockIcon: View {
    let name: LucideName
    var body: some View { Lucide(name, size: 15, color: Theme.muted).frame(width: 28, height: 28) }
}

private struct MockMark: View {
    let mark: String
    var body: some View {
        Text(verbatim: mark).font(.system(size: 15, weight: .medium, design: .rounded)).foregroundStyle(Theme.muted).frame(width: 28, height: 28)
    }
}

/// The model and effort picker: "Opus 5.5 1M · Medium ⌄". `quiet`: no fill, for a row that already has a surface.
private struct MockModelChip: View {
    let state: ComposerMockState
    var showsDuck = false
    var filled = true
    var body: some View {
        HStack(spacing: 5) {
            if showsDuck {
                ThreadDuckView(id: "pickle", size: 14)
                Text(verbatim: state.duck).foregroundStyle(Theme.ink).fontWeight(.medium)
                Text(verbatim: "\u{00B7}").foregroundStyle(Theme.subtle)
            }
            Text(verbatim: state.model).foregroundStyle(Theme.ink).fontWeight(.medium)
            Text(verbatim: state.effort).foregroundStyle(Theme.muted)
            Lucide(.chevronDown, size: 10, color: Theme.muted)
        }
        .font(.system(size: 12)).lineLimit(1).fixedSize()
        .padding(.horizontal, 8).frame(height: 26)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(filled ? Theme.selected : .clear))
    }
}

/// The mode, glyph and word always (§8.10), at the model chip's height and radius so the two read as one pair.
private struct MockModeChip: View {
    let mode: ComposerMode
    var compact = false
    private var tint: Color {
        switch mode.tone {
        case .neutral: Theme.muted
        case .done: Theme.info
        case .working: Theme.success
        case .needsYou: Theme.negative
        }
    }

    private var glyph: LucideName {
        switch mode {
        case .ask: .shield
        case .acceptEdits: .filePen
        case .plan: .clipboardList
        case .skipApprovals: .zapOff
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Lucide(glyph, size: 12, color: tint)
            Text(verbatim: compact && mode == .skipApprovals ? "Skip" : mode.word).foregroundStyle(tint)
        }
        .font(.system(size: 12, weight: .medium)).lineLimit(1).fixedSize()
        .padding(.horizontal, 8).frame(height: 26)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(tint.opacity(0.12)))
    }
}

/// The context ring, 16pt in a 28pt slot.
private struct MockRing: View {
    let used: Double
    var body: some View {
        ZStack {
            Circle().stroke(Theme.lineStrong, lineWidth: 2)
            Circle().trim(from: 0, to: used / 100).stroke(Theme.muted, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
        }
        .frame(width: 15, height: 15).frame(width: 28, height: 28)
    }
}

/// Send, Steer or Stop, always the same 30pt slot at the toolbar's trailing edge. While the agent works and words are typed,
/// the button steers and its hint sits just before it: "Steers now · ⌘↩ to queue".
private struct MockSendCluster: View {
    let state: ComposerMockState
    var body: some View {
        HStack(spacing: 8) {
            if state.working, !state.text.isEmpty {
                Text(verbatim: "Steers now \u{00B7} \u{2318}\u{21A9} to queue").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    .lineLimit(1).fixedSize()
            }
            if state.working, state.text.isEmpty {
                RoundStopLabel().frame(width: 32, height: 32)
            } else {
                DuckSendDisc(enabled: !state.text.isEmpty)
            }
        }
    }
}

/// One duckling chip: mark, title cut at a word, age. Its full text (with the model) is the tooltip.
private struct MockDucklingChip: View {
    let duckling: Duckling
    let now: Date
    var body: some View {
        HStack(spacing: 5) {
            DucklingStatusMark(duckling: duckling)
            Text(verbatim: ComposerDesign.chipTitle(duckling.title, maxCharacters: 26)).foregroundStyle(Theme.ink)
            if let age = duckling.elapsed(now: now) { Text(verbatim: age).foregroundStyle(Theme.subtle).monospacedDigit() }
        }
        .font(.system(size: 11.5)).lineLimit(1).fixedSize()
        .padding(.horizontal, 8).frame(height: 22)
        .background(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).fill(Theme.selected))
        .help(duckling.chipText(now: now))
    }
}

/// As many whole chips as fit, then "+N" for the rest: never a chip cut by the edge.
private struct MockDucklingChips: View {
    let ducklings: [Duckling]
    let now: Date
    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Array(stride(from: ducklings.count, through: 0, by: -1)), id: \.self) { k in
                HStack(spacing: 6) {
                    ForEach(ducklings.prefix(k)) { MockDucklingChip(duckling: $0, now: now) }
                    if k < ducklings.count { overflow(ducklings.count - k) }
                }
                .fixedSize()
            }
        }
    }

    private func overflow(_ n: Int) -> some View {
        Text(verbatim: "+\(n)").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.muted).monospacedDigit()
            .padding(.horizontal, 7).frame(height: 22)
            .background(RoundedRectangle(cornerRadius: Radius.chip, style: .continuous).strokeBorder(Theme.lineStrong))
            .help("Show all ducklings")
    }
}

/// "Working · editing auth.ts" / "2 ducklings running": the line's lead, with the working glyph only while something runs.
private struct MockStatusLead: View {
    let state: ComposerMockState
    /// The tray's short form: "2 running", "Working".
    var compact = false
    var body: some View {
        HStack(spacing: 6) {
            if state.working || state.running > 0 {
                WorkingGlyph(slot: 18, grid: .compact)
            }
            Text(verbatim: lead).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
        }
    }

    private var lead: String {
        if compact {
            if state.running > 0 { return "\(state.running) running" }
            return state.working ? "Working" : ""
        }
        if state.working {
            let base = state.step.map { "Working \u{00B7} \($0)" } ?? "Working"
            return state.running > 0 ? "\(base) \u{00B7} \(DucklingWords.count(state.running))" : base
        }
        return DucklingWords.readyLine(running: state.running) ?? "Ready"
    }
}

// MARK: Direction A: unified card

/// One surface, three bands: the status line (only with ducklings or a turn), the text, the toolbar.
struct ComposerMockA: View {
    let state: ComposerMockState
    let now: Date

    private var showsStatus: Bool { state.working || !state.ducklings.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            if showsStatus {
                HStack(spacing: 10) {
                    MockStatusLead(state: state)
                    if !state.ducklings.isEmpty {
                        MockDucklingChips(ducklings: state.ducklings, now: now)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).frame(height: 34)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            MockTextArea(state: state).padding(.horizontal, 14).padding(.top, 8)
            HStack(spacing: 2) {
                MockIcon(name: .paperclip)
                MockMark(mark: "@")
                MockMark(mark: "/")
                Rectangle().fill(Theme.line).frame(width: 1, height: 16).padding(.horizontal, 6)
                HStack(spacing: 6) {
                    MockModelChip(state: state)
                    MockModeChip(mode: state.mode)
                }
                Spacer(minLength: 8)
                MockRing(used: state.contextUsed)
                MockIcon(name: .mic)
                MockSendCluster(state: state).padding(.leading, 4)
            }
            .frame(height: ComposerMock.toolbar)
            .padding(.horizontal, 8).padding(.bottom, 6)
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Theme.lineStrong.opacity(0.8)))
    }
}

// MARK: Direction B: attached tray

/// The box is the hero; one tray fused to its top edge carries the model and mode at the left and the ducklings at the right.
/// Same width, same outer radius, one outline: they read as one object.
struct ComposerMockB: View {
    let state: ComposerMockState
    let now: Date
    private let r = Radius.panel

    var body: some View {
        VStack(spacing: 0) {
            tray
            Rectangle().fill(Theme.line).frame(height: 1)
            box
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: r, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: r, style: .continuous).strokeBorder(Theme.lineStrong.opacity(0.8)))
    }

    private var tray: some View {
        HStack(spacing: 8) {
            MockModelChip(state: state, showsDuck: true, filled: false)
            MockModeChip(mode: state.mode)
            Spacer(minLength: 12)
            if !state.ducklings.isEmpty || state.working {
                MockStatusLead(state: state, compact: true)
                if !state.ducklings.isEmpty { MockDucklingChips(ducklings: state.ducklings, now: now).layoutPriority(-1) }
            }
        }
        .padding(.leading, 6).padding(.trailing, 8).frame(height: 38)
        // The tray is a tone off the box (`selected` over `surface`), so the box reads as the hero and the tray as its lid.
        .background(Theme.selected.opacity(0.85), in: UnevenRoundedRectangle(topLeadingRadius: r, topTrailingRadius: r, style: .continuous))
    }

    private var box: some View {
        VStack(spacing: 0) {
            MockTextArea(state: state).padding(.horizontal, 14).padding(.top, 10)
            HStack(spacing: 2) {
                MockIcon(name: .paperclip)
                MockMark(mark: "@")
                MockMark(mark: "/")
                MockIcon(name: .mic)
                Spacer(minLength: 8)
                MockRing(used: state.contextUsed)
                MockSendCluster(state: state).padding(.leading, 4)
            }
            .frame(height: ComposerMock.toolbar)
            .padding(.horizontal, 8).padding(.bottom, 6)
        }
    }
}

// MARK: Snapshot scenes

@MainActor
enum ComposerMockScenes {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static let several: [Duckling] = [
        Duckling(id: "d1", title: "YouTube: shared Google sign-in + Studio fallback", model: "Opus 5.5", status: .running,
                 startedAt: now.addingTimeInterval(-372)),
        Duckling(id: "d2", title: "Sign in with Zoom: core flow and token refresh", model: "Sonnet 5.5", status: .running,
                 startedAt: now.addingTimeInterval(-131)),
        Duckling(id: "d3", title: "Review the diff", model: "Haiku 5", status: .done,
                 startedAt: now.addingTimeInterval(-240), endedAt: now.addingTimeInterval(-20)),
    ]

    static let longText = """
        Two things before you ship this. First, the Google sign-in sheet still flashes white in dark mode for a frame before \
        the web view paints; give the container our bg colour so it never shows. Second, the Studio fallback should only kick \
        in when the YouTube scope is denied, not when the person cancels.

        Also:
        - keep the token refresh on the same queue as the sign-in, so two refreshes never race
        - log the scope we asked for and the one we got, without the token itself
        - the "Try again" button needs the same height as "Continue"
        - check the Zoom path still works when both accounts are signed in at once
        - and add a regression test for the cancel case, beside the sign-in tests

        When that is done, write a short note in the PR about what changed for people who already signed in.
        """

    /// The states the owner asked for: idle, working (steer), no ducklings versus several, long text.
    static func states() -> [(name: String, state: ComposerMockState)] {
        [
            ("idle", ComposerMockState()),
            ("idle-typed", ComposerMockState(text: "Can you check the sign-in on a clean account?")),
            ("ducklings", ComposerMockState(ducklings: several)),
            ("working", ComposerMockState(ducklings: several, working: true, step: "editing auth.ts",
                                          text: "Use the shared sheet for Zoom too")),
            ("working-empty", ComposerMockState(working: true, step: "running tests")),
            ("longtext", ComposerMockState(ducklings: several, text: longText)),
        ]
    }

    /// The composer at the bottom of a chat, at the reading column's width, with the end of an answer faded above it.
    static func scene(_ composer: some View, dark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("I moved the sign-in into one shared sheet, so Google and Zoom open the same way and dark mode no longer flashes. Two ducklings are still checking the edge cases.")
                .font(.system(size: 14)).foregroundStyle(Theme.ink).lineSpacing(5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 20)
                .mask(LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom))
            Spacer(minLength: 16)
            composer
        }
        .padding(.horizontal, Metrics.readingInset).padding(.bottom, 20)
        .frame(width: Metrics.readingColumn + 2 * Metrics.readingInset, height: 460)
        .background(Theme.bg)
    }
}
