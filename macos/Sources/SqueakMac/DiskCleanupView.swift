import AppKit
import SqueakMacCore
import SwiftUI

// Clean up disk (DESIGN.md: one column, plain words, a real button for each action). Lists what Squeak left on disk
// in groups with sizes, safe items ticked, anything with unsaved work unticked and marked. Nothing is deleted before
// the confirm, folders go to the Trash and branches only when merged.

struct DiskCleanupRequest: Identifiable, Equatable {
    let id = UUID()
    var pondId: String?
    var pondName: String?
}

/// The sheet's request and the archive offer's state; both are drawn from the workbench sidebar.
@MainActor @Observable
final class DiskCleanupCenter {
    static let shared = DiskCleanupCenter()
    var request: DiskCleanupRequest?
    var branchOffer: BranchOffer?

    struct BranchOffer: Equatable, Identifiable {
        let id = UUID()
        var workspaceId: String
        var branch: String
        var note: String?
    }

    func open(pondId: String? = nil, pondName: String? = nil) {
        request = DiskCleanupRequest(pondId: pondId, pondName: pondName)
    }
}

extension View {
    func diskCleanupSheet() -> some View {
        @Bindable var center = DiskCleanupCenter.shared
        return sheet(item: $center.request) { DiskCleanupSheet(request: $0) }
            .safeAreaInset(edge: .bottom, spacing: 0) { BranchOfferBar() }
    }
}

/// After an archive: "Branch x is merged. Delete it?" with Delete / Keep, and the GitHub copy only if ticked.
struct BranchOfferBar: View {
    @Environment(AppModel.self) private var model
    @State private var alsoOnGitHub = false
    @State private var busy = false

    var body: some View {
        if let offer = DiskCleanupCenter.shared.branchOffer {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(verbatim: offer.note ?? DiskCleanupLogic.branchOffer(offer.branch))
                    .font(Typo.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                if offer.note == nil {
                    Toggle("Also on GitHub", isOn: $alsoOnGitHub).toggleStyle(.checkbox).font(Typo.footnote)
                    HStack(spacing: Space.s) {
                        Button("Delete") { delete(offer) }.buttonStyle(SecondaryButtonStyle()).disabled(busy)
                        Button("Keep") { DiskCleanupCenter.shared.branchOffer = nil }.buttonStyle(SecondaryButtonStyle())
                    }
                } else {
                    Button("OK") { DiskCleanupCenter.shared.branchOffer = nil }.buttonStyle(SecondaryButtonStyle())
                }
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceRaised)
            .overlay(alignment: .top) { Divider().overlay(Theme.line) }
        }
    }

    private func delete(_ offer: DiskCleanupCenter.BranchOffer) {
        busy = true
        Task {
            defer { busy = false }
            do {
                let r = try await model.nativeHost.deleteBranch(workspaceId: offer.workspaceId, alsoOnGitHub: alsoOnGitHub)
                var note = "Deleted \(offer.branch)."
                if alsoOnGitHub { note += r.remoteDeleted ? " Also deleted on GitHub." : " \(r.note ?? "It stays on GitHub.")" }
                DiskCleanupCenter.shared.branchOffer = .init(workspaceId: offer.workspaceId, branch: offer.branch, note: note)
            } catch {
                DiskCleanupCenter.shared.branchOffer = .init(
                    workspaceId: offer.workspaceId, branch: offer.branch,
                    note: (error as? NativeHostError)?.reason ?? "Squeak couldn't delete the branch.")
            }
            alsoOnGitHub = false
        }
    }
}

struct DiskCleanupSheet: View {
    let request: DiskCleanupRequest
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable { case scanning, ready, cleaning, done(String), failed(String) }
    @State private var phase: Phase = .scanning
    @State private var scan: CleanupScan?
    @State private var selection: Set<String> = []
    @State private var alsoOnGitHub = false
    @State private var confirming = false

    private var items: [CleanupItem] { scan?.items ?? [] }
    private var picked: Set<String> { selection.intersection(items.map(\.id)) }
    private var unsavedPicked: Int { items.filter { picked.contains($0.id) && $0.unsavedWork }.count }
    private var confirmText: String {
        var text = DiskCleanupLogic.confirmation(items, in: picked)
        if unsavedPicked > 0 { text += " \(unsavedPicked == 1 ? "1 of them has" : "\(unsavedPicked) of them have") unsaved work. It stays in the Trash until you empty it." }
        return text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            header
            content
            footer
        }
        .padding(Space.xl).frame(width: 640, height: 560)
        .background(Theme.bg)
        .task { await load() }
        .confirmationDialog("Clean up disk?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Clean up", role: .destructive) { clean() }
            Button("Cancel", role: .cancel) {}
        } message: { Text(verbatim: confirmText) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(request.pondName.map { "Clean up disk: \($0)" } ?? "Clean up disk").font(Typo.title).foregroundStyle(Theme.ink)
            if scan != nil, phase == .ready || phase == .cleaning {
                Text(verbatim: "\(DiskCleanupLogic.size(DiskCleanupLogic.bytes(items, in: picked))) selected, \(DiskCleanupLogic.size(scan?.reclaimableBytes)) can be freed safely")
                    .font(Typo.body).foregroundStyle(Theme.muted)
            } else {
                Text("Folders go to the Trash, so you can still get them back. Nothing is removed until you confirm.")
                    .font(Typo.footnote).foregroundStyle(Theme.muted)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .scanning:
            VStack(spacing: Space.s) {
                ProgressView().controlSize(.regular)
                Text("Measuring folders\u{2026} this can take a minute on a big disk.").font(Typo.footnote).foregroundStyle(Theme.muted)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let why):
            Text(verbatim: why).font(Typo.body).foregroundStyle(Theme.negative).textSelection(.enabled)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case .done(let line):
            VStack(alignment: .leading, spacing: Space.s) {
                Text(verbatim: line).font(Typo.body).foregroundStyle(Theme.ink)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case .ready, .cleaning:
            if items.isEmpty {
                Text("Nothing to clean up. Everything on disk belongs to a stream.").font(Typo.body).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.l) {
                        ForEach(DiskCleanupLogic.groups(items)) { group in groupView(group) }
                        if items.contains(where: { $0.kind == "merged-branch" }) {
                            Toggle("Also delete merged branches on GitHub", isOn: $alsoOnGitHub).toggleStyle(.checkbox).font(Typo.footnote)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .disabled(phase == .cleaning)
            }
        }
    }

    private func groupView(_ group: DiskCleanupLogic.Group) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "\(group.title) (\(group.items.count))").font(Typo.heading).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(verbatim: group.detail).font(Typo.footnote).foregroundStyle(Theme.muted)
                }
                Spacer()
                Text(verbatim: DiskCleanupLogic.size(group.items.reduce(0) { $0 + ($1.sizeBytes ?? 0) })).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            VStack(spacing: 0) {
                ForEach(group.items) { item in
                    row(item)
                    if item.id != group.items.last?.id { Divider().overlay(Theme.line) }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        }
    }

    private func row(_ item: CleanupItem) -> some View {
        Toggle(isOn: Binding(
            get: { selection.contains(item.id) },
            set: { on in if on { selection.insert(item.id) } else { selection.remove(item.id) } }
        )) {
            HStack(alignment: .top, spacing: Space.m) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Space.s) {
                        Text(verbatim: item.kind == "merged-branch" ? (item.branch ?? item.label) : item.label).font(Typo.label).foregroundStyle(Theme.ink)
                        if request.pondId == nil, let pond = item.pondName {
                            Text(verbatim: pond).font(Typo.meta).foregroundStyle(Theme.subtle)
                        }
                        if item.unsavedWork {
                            Text("Has unsaved work").font(Typo.meta).foregroundStyle(Theme.warning)
                                .help(item.unsavedReason ?? "Unsaved work")
                        }
                    }
                    if let path = item.path {
                        Text(verbatim: path).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                    }
                    if item.unsavedWork, let why = item.unsavedReason {
                        Text(verbatim: why).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 2) {
                    if item.path != nil && item.kind != "stale-worktree" {
                        Text(verbatim: DiskCleanupLogic.size(item.sizeBytes)).font(Typo.footnote).foregroundStyle(Theme.ink)
                    }
                    if let date = Self.modified(item.modifiedAt) {
                        Text(verbatim: date).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .toggleStyle(.checkbox)
        .padding(.horizontal, Space.m).padding(.vertical, Space.s)
    }

    private static func modified(_ iso: String?) -> String? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let iso, let date = fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }

    private var footer: some View {
        HStack(spacing: Space.s) {
            if phase == .cleaning {
                ProgressView().controlSize(.small)
                Text("Cleaning up\u{2026}").font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            Spacer()
            if case .done = phase {
                Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            } else {
                Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction).disabled(phase == .cleaning)
                if phase == .ready, !items.isEmpty {
                    Button("Clean up\u{2026}") { confirming = true }.buttonStyle(PrimaryButtonStyle()).disabled(picked.isEmpty)
                }
            }
        }
    }

    private func load() async {
        phase = .scanning
        if model.demoMode { scan = CleanupScan(items: [], reclaimableBytes: 0, scannedAt: ""); phase = .ready; return }
        do {
            let result = try await model.nativeHost.diskCleanupScan(pondId: request.pondId)
            scan = result
            selection = DiskCleanupLogic.initialSelection(result.items)
            phase = .ready
        } catch let e as NativeHostError { phase = .failed(e.reason) } catch { phase = .failed("Squeak couldn't reach its session host.") }
    }

    private func clean() {
        let ids = items.filter { picked.contains($0.id) }.map(\.id)
        let confirmed = Set(items.filter { picked.contains($0.id) && $0.unsavedWork }.map(\.id))
        phase = .cleaning
        Task {
            do {
                let r = try await model.nativeHost.diskCleanup(ids: ids, confirmUnsaved: confirmed, pondId: request.pondId, alsoOnGitHub: alsoOnGitHub)
                phase = .done(DiskCleanupLogic.resultLine(r))
                await model.refreshNativeWorkspaces()
            } catch let e as NativeHostError { phase = .failed(e.reason) } catch { phase = .failed("Squeak couldn't finish. Run Clean up disk again to see what is left.") }
        }
    }
}
