import AppKit
import CoreImage.CIFilterBuiltins
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond sheets: invite (a code with a visible Copy and its expiry),
// join with a pasted code. Controls say what they do; Pond and Flock only name things.

extension View {
    /// Presents `PondsModel.sheet` over this view.
    func pondSheets() -> some View {
        @Bindable var ponds = PondsModel.shared
        return sheet(item: $ponds.sheet) { sheet in
            switch sheet {
            case .invite(let pondId): InvitePondSheet(pondId: pondId)
            case .join: JoinPondSheet()
            }
        }
    }
}

private struct SheetFrame<Content: View>: View {
    let title: String
    let content: Content
    init(_ title: String, @ViewBuilder _ content: () -> Content) { self.title = title; self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            Text(verbatim: title).font(Typo.title).foregroundStyle(Theme.ink)
            content
        }
        .padding(Space.xl).frame(width: 440).background(Theme.surface)
    }
}

// MARK: Invite

/// One sheet, two steps of the same size that crossfade: choose what they can do, then the link, the code and a QR.
struct InvitePondSheet: View {
    let pondId: String
    @Environment(\.dismiss) private var dismiss
    @State private var state = InviteSheetState()
    @State private var now = Date()
    @FocusState private var cardsFocused: Bool
    private var ponds: PondsModel { .shared }
    private var pondName: String { ponds.ponds.first { $0.id == pondId }?.name ?? "the pond" }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            header
            ZStack(alignment: .topLeading) {
                chooseStep.opacity(state.step == .choose ? 1 : 0).allowsHitTesting(state.step == .choose)
                    .accessibilityHidden(state.step != .choose)
                readyStep.opacity(state.step == .ready ? 1 : 0).allowsHitTesting(state.step == .ready)
                    .accessibilityHidden(state.step != .ready)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            buttons
        }
        .padding(Space.xl).frame(width: 480).background(Theme.surface)
        .animation(Motion.standard, value: state.step)
        .onAppear { ponds.note = nil; cardsFocused = true }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: Space.m) {
            PondTile(name: pondName, pondId: pondId, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: state.step == .ready ? "Invite ready" : InviteSheetText.headline(pond: pondName))
                    .font(Typo.title).foregroundStyle(Theme.ink)
                Text(verbatim: state.step == .ready ? "Send the link or the code, or let them scan the QR code." : InviteSheetText.subtitle)
                    .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Step 1

    private var chooseStep: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.m) {
                ForEach([PondRole.member, .viewer], id: \.self) { roleCard($0) }
            }
            // Both steps sit in one ZStack, so it is as tall as the taller one; the cards keep their own height.
            .fixedSize(horizontal: false, vertical: true)
            .focusable().focused($cardsFocused).focusEffectDisabled()
            .onKeyPress(.leftArrow) { withAnimation(Motion.quick) { state.move(-1) }; return .handled }
            .onKeyPress(.rightArrow) { withAnimation(Motion.quick) { state.move(1) }; return .handled }
            .accessibilityElement(children: .contain).accessibilityLabel("They can")
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: InviteSheetText.approval)
                Text(verbatim: InviteSheetText.expiryNote())
            }
            .font(Typo.footnote).foregroundStyle(Theme.muted)
            if let error = state.error {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Text(verbatim: error).font(Typo.footnote).foregroundStyle(Theme.negative)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Retry") { create() }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
    }

    private func roleCard(_ r: PondRole) -> some View {
        let on = state.role == r
        return Button { withAnimation(Motion.quick) { state.role = r } } label: {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack {
                    Lucide(r == .viewer ? .eye : .messageSquare, size: 18, color: Theme.ink)
                    Spacer()
                    if on { Lucide(.check, size: 14, color: Theme.ink) }
                }
                Text(verbatim: InviteSheetText.roleTitle(r)).font(Typo.heading).foregroundStyle(Theme.ink)
                Text(verbatim: InviteSheetText.roleBlurb(r)).font(Typo.footnote).foregroundStyle(Theme.muted)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(Space.m).frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading)
            .background(on ? PondColour.tint(pondId) : Theme.selected, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(on ? PondColour.accent : Theme.line, lineWidth: on ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(InviteSheetText.roleTitle(r)). \(InviteSheetText.roleBlurb(r))")
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
    }

    // MARK: Step 2

    private var readyStep: some View {
        let invite = state.invite
        return VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.s) {
                Text(verbatim: state.role.word).font(Typo.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
                    .padding(.horizontal, Space.s).padding(.vertical, 2)
                    .background(PondColour.tint(pondId), in: RoundedRectangle(cornerRadius: Radius.chip))
                Text(verbatim: InviteSheetText.waiting(role: state.role)).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            HStack(alignment: .center, spacing: Space.l) {
                VStack(alignment: .leading, spacing: Space.m) {
                    if let link = invite?.link { field("Invite link", link, kind: .link) }
                    field("Code", invite?.code ?? "", kind: .code)
                }
                if let invite { qr(invite.shareable) }
            }
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                if let line = PondInviteText.expiry(invite?.expiresAt, now: ctx.date) {
                    Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted)
                }
            }
        }
    }

    private enum Kind { case link, code }

    private func field(_ title: String, _ value: String, kind: Kind) -> some View {
        let feedback = kind == .link ? state.link : state.code
        // One line per value, middle-truncated, with its Copy button inside the field: a long link or code never wraps.
        return VStack(alignment: .leading, spacing: Space.xs) {
            Text(verbatim: title).font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Text(verbatim: value).font(Typo.footnoteMono).foregroundStyle(Theme.ink)
                    .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(value)
                Button(feedback.label("Copy", now: now)) { copy(value, kind) }
                    .buttonStyle(SecondaryButtonStyle()).fixedSize().accessibilityLabel("Copy \(title.lowercased())")
            }
            .padding(.leading, Space.m).padding(.trailing, Space.xs).padding(.vertical, Space.xs)
            .background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.control))
        }
    }

    private func qr(_ text: String) -> some View {
        Group {
            if let image = InviteQR.image(text, side: 132) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: 132, height: 132)
            }
        }
        .padding(Space.s).background(.white, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(PondColour.tint(pondId), lineWidth: 4))
        .accessibilityLabel("QR code for the invite")
    }

    private func copy(_ text: String, _ kind: Kind) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        now = Date()
        if kind == .link { state.link.copied(at: now) } else { state.code.copied(at: now) }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(CopyFeedback.holdFor + 0.05))
            now = Date()
        }
    }

    // MARK: Buttons

    private var buttons: some View {
        HStack {
            if state.step == .ready { ShareButton(text: state.shareText) }
            Spacer()
            if state.step == .choose {
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button(state.creating ? "Creating\u{2026}" : "Create invite") { create() }
                    .buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(!state.canCreate)
            } else {
                Button("Done") { dismiss() }.buttonStyle(PondPrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                Button("") { dismiss() }.keyboardShortcut(.cancelAction).frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
            }
        }
    }

    private func create() {
        guard state.canCreate else { return }
        state.startCreating()
        Task {
            if let made = await ponds.invite(pond: pondId, role: state.role) {
                withAnimation(Motion.standard) { state.created(made) }
            } else {
                state.failed(ponds.note)
            }
        }
    }
}

/// "Share\u{2026}": the system sharing picker for the link (or the code).
private struct ShareButton: View {
    let text: String
    @State private var anchor: NSView?

    var body: some View {
        Button("Share\u{2026}") {
            guard let anchor else { return }
            NSSharingServicePicker(items: [text]).show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .minY)
        }
        .buttonStyle(SecondaryButtonStyle())
        .background(AnchorView { anchor = $0 })
    }
}

private struct AnchorView: NSViewRepresentable {
    let got: (NSView) -> Void
    func makeNSView(context: Context) -> NSView { let v = NSView(); DispatchQueue.main.async { got(v) }; return v }
    func updateNSView(_ v: NSView, context: Context) {}
}

/// A crisp QR code: CoreImage's generator, scaled by whole pixels with no smoothing.
enum InviteQR {
    static func image(_ text: String, side: CGFloat) -> NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage else { return nil }
        let scale = max(1, floor(side * 2 / out.extent.width))
        let scaled = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: NSSize(width: rep.size.width / 2, height: rep.size.height / 2))
        image.addRepresentation(rep)
        return image
    }
}

// MARK: Join

struct JoinPondSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetFrame("Join a pond") { JoinPondForm(dismiss: { dismiss() }) }
    }
}

/// The join form, in the sheet and inline on the Create page.
struct JoinPondForm: View {
    var dismiss: () -> Void
    /// The sheet has Cancel and Close; the page is already where the person is.
    var inline = false
    @State private var code = ""
    @State private var name = NSFullUserName()
    @State private var phase: Phase = .entering
    private var ponds: PondsModel { .shared }

    enum Phase: Equatable { case entering, sending, waiting(pondId: String), joined(name: String) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            switch phase {
            case .entering, .sending:
                TextField("Paste the invite code", text: $code).textFieldStyle(.roundedBorder).font(Typo.code)
                    .onSubmit { if phase == .entering, PondInviteText.canJoin(code: code, name: name) { ask() } }
                TextField("Your name in the pond", text: $name).textFieldStyle(.roundedBorder)
                Text("An owner approves you on their Mac before you see anything.").font(Typo.footnote).foregroundStyle(Theme.muted)
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
                HStack {
                    Spacer()
                    if !inline { Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction) }
                    let askButton = Button(phase == .sending ? "Asking\u{2026}" : "Ask to join") { ask() }
                        .buttonStyle(PondPrimaryButtonStyle())
                        .disabled(phase == .sending || !PondInviteText.canJoin(code: code, name: name))
                    if inline { askButton } else { askButton.keyboardShortcut(.defaultAction) }
                }
            case .waiting(let id):
                HStack(spacing: Space.s) {
                    WorkingGlyph(width: 20, height: 15)
                    Text("Waiting for the owner to approve").font(Typo.label).foregroundStyle(Theme.ink)
                }
                Text(inline ? "The pond appears in the sidebar once you\u{2019}re approved." : "You can close this. The pond appears in the sidebar once you\u{2019}re approved.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
                if !inline {
                    HStack { Spacer(); Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.defaultAction) }
                }
                Color.clear.frame(height: 0).task(id: id) { await waitForApproval(id) }
            case .joined(let pond):
                Text(verbatim: "You\u{2019}re in \(pond).").font(Typo.body).foregroundStyle(Theme.ink)
                HStack {
                    Spacer()
                    Button("Open") { ponds.route = .home(project: pond); dismiss() }.buttonStyle(PondPrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                }
            }
        }
        .onAppear { ponds.note = nil }
    }

    private func ask() {
        guard let clean = PondInviteText.cleaned(code) else { return }
        phase = .sending
        Task {
            if let r = await ponds.join(code: clean, name: name.trimmingCharacters(in: .whitespaces)) {
                phase = r.isPending ? .waiting(pondId: r.pondId) : .joined(name: ponds.ponds.first { $0.id == r.pondId }?.name ?? "the pond")
            } else {
                phase = .entering
            }
        }
    }

    /// Reads the list until the pond is in it: the owner's approval is what puts it there.
    private func waitForApproval(_ id: String) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            await ponds.refresh()
            if let p = ponds.ponds.first(where: { $0.id == id }) { phase = .joined(name: p.name); return }
        }
    }
}
