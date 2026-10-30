import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

enum UninstallPhase: Equatable { case loading, noCLI, plan, running, finished, failedToStart }

/// Drives the sheet: the dry-run plan, then the live run. All decisions come from the CLI's JSON lines.
@MainActor @Observable
final class UninstallModel {
    var phase: UninstallPhase = .loading
    var plan: UninstallPlan?
    var keepData = false { didSet { if oldValue != keepData { Task { await loadPlan() } } } }
    var states: [String: UninstallStepEvent] = [:]
    var result: UninstallResult?
    var message: String?
    private let runner = UninstallRunner.live()

    func loadPlan() async {
        guard runner.cli != nil else { phase = .noCLI; return }
        phase = .loading
        do {
            let r = try await runner.run(dryRun: true, keepData: keepData)
            plan = r.plan
            phase = r.plan == nil ? .failedToStart : .plan
            message = r.plan == nil ? (r.failure ?? UninstallRunner.fallbackNote) : nil
        } catch { phase = .noCLI }
    }

    func start() async {
        states = [:]; result = nil; message = nil
        phase = .running
        let box = self
        do {
            let r = try await runner.run(dryRun: false, keepData: keepData) { event in
                if case .step(let s) = event { Task { @MainActor in box.states[s.id] = s } }
            }
            for s in r.steps { states[s.id] = s }
            result = r
            phase = .finished
        } catch { phase = .noCLI }
    }

    func trashAndQuit() {
        guard let path = result?.done?.appToTrash, result?.ok == true else { NSApp.terminate(nil); return }
        NSWorkspace.shared.recycle([URL(fileURLWithPath: path)]) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

/// Settings › About › "Uninstall Squeak…": plan first, then confirm, then live per-step state.
struct UninstallSheet: View {
    var availableSize = CGSize(width: 500, height: 560)

    @Environment(\.dismiss) private var dismiss
    @State private var model = UninstallModel()
    @State private var confirming = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            Text("Uninstall Squeak").font(Typo.title).foregroundStyle(Theme.ink)
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.visible)
            .frame(maxHeight: .infinity)
            Hairline()
            if model.phase == .plan {
                Toggle("Keep my Squeak settings", isOn: $model.keepData).font(Typo.body)
            }
            footer
        }
        .padding(20)
        .frame(width: availableSize.width, height: availableSize.height)
        .task { await model.loadPlan() }
        .confirmationDialog("Uninstall Squeak?", isPresented: $confirming) {
            Button("Uninstall", role: .destructive) { Task { await model.start() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.keepData ? "Squeak is removed; your settings stay." : "Squeak and its settings are removed from this Mac.")
        }
        .interactiveDismissDisabled(model.phase == .running)
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            HStack(spacing: Space.s) { ProgressView().controlSize(.small); Text("Checking what Squeak would remove").font(Typo.body).foregroundStyle(Theme.muted) }
        case .noCLI:
            Text("Squeak's uninstaller was not found in this copy. Use the Terminal command in docs/uninstall.md.")
                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        case .failedToStart:
            Text(model.message ?? UninstallRunner.fallbackNote).font(Typo.body).foregroundStyle(Theme.muted)
        case .plan:
            Text("Nothing is changed until you confirm. Conductor is handed back first.")
                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            stepList(plan: true)
        case .running:
            stepList(plan: false)
            Footnote("Don't quit Squeak while this runs. macOS may ask for your password once.")
        case .finished:
            stepList(plan: false)
            finished
        }
    }

    private func stepList(plan: Bool) -> some View {
        let steps = model.plan?.steps ?? []
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(steps) { step in
                row(step, plan: plan)
                if step.id != steps.last?.id { Hairline() }
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
    }

    private func row(_ step: UninstallPlanStep, plan: Bool) -> some View {
        let state = model.states[step.id]
        return HStack(alignment: .top, spacing: Space.s) {
            if !plan { indicator(state).frame(width: 16, height: 16) }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Space.s) {
                    Text(step.title).font(Typo.label).foregroundStyle(Theme.ink)
                    if step.needsAdmin { Text("Asks for your password").font(Typo.meta).foregroundStyle(Theme.muted) }
                }
                Text(step.detail).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                if plan {
                    ForEach(step.items, id: \.self) {
                        Text($0).font(Typo.code).foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
                if !plan, let note = state?.note, !note.isEmpty, state?.status != .start {
                    Text(note).font(Typo.meta).foregroundStyle(state?.status == .failed ? Theme.needsYou : Theme.muted)
                }
            }
            Spacer(minLength: 0)
            if !plan { Text(label(state)).font(Typo.meta).foregroundStyle(state?.status == .failed ? Theme.needsYou : Theme.muted) }
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.s)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func indicator(_ s: UninstallStepEvent?) -> some View {
        switch s?.status {
        case .start: ProgressView().controlSize(.small)
        case .done: Lucide(.check, size: 14, color: Theme.working)
        case .skipped: Circle().strokeBorder(Theme.offline, lineWidth: 1.5).frame(width: 10, height: 10)
        case .failed: Circle().fill(Theme.needsYou).frame(width: 8, height: 8)
        case nil: Circle().fill(Theme.muted.opacity(0.5)).frame(width: 8, height: 8)
        }
    }

    private func label(_ s: UninstallStepEvent?) -> String {
        switch s?.status {
        case .start: "Working"
        case .done: "Done"
        case .skipped: "Skipped"
        case .failed: "Failed"
        case nil: "Waiting"
        }
    }

    @ViewBuilder private var finished: some View {
        let r = model.result
        if r?.ok == true, let done = r?.done {
            Text("Squeak is removed from this Mac").font(Typo.heading).foregroundStyle(Theme.ink)
            if done.restartConductor {
                Footnote("Restart Conductor once so it stops using Squeak.")
            }
            if !done.offMac.isEmpty {
                Text("Still yours to remove").font(Typo.label).foregroundStyle(Theme.ink)
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(Array(done.offMac.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).font(Typo.label).foregroundStyle(Theme.ink)
                            Text(item.detail).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                            if let u = item.url, let url = URL(string: u), url.scheme == "https" {
                                Button(u) { NSWorkspace.shared.open(url) }.buttonStyle(.link).font(Typo.meta)
                            }
                        }
                    }
                }
            }
        } else {
            let failed = (model.plan?.steps ?? []).filter { model.states[$0.id]?.status == .failed }
            Text("Squeak is not fully removed").font(Typo.heading).foregroundStyle(Theme.ink)
            ForEach(failed) { s in
                Footnote("\(s.title): \(model.states[s.id]?.note ?? "failed")")
            }
            if failed.isEmpty { Footnote(r?.failure ?? UninstallRunner.fallbackNote) }
            Footnote("Squeak.app stays where it is. Run again to finish.")
        }
    }

    @ViewBuilder private var footer: some View {
        HStack {
            Spacer()
            switch model.phase {
            case .loading, .noCLI, .failedToStart:
                Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
            case .plan:
                Button("Cancel") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button("Uninstall…") { confirming = true }.buttonStyle(DestructiveButtonStyle())
            case .running:
                EmptyView()
            case .finished:
                if model.result?.ok == true {
                    Button("Move Squeak to the Trash and Quit") { model.trashAndQuit() }.buttonStyle(DestructiveButtonStyle())
                } else {
                    Button("Close") { dismiss() }.buttonStyle(SecondaryButtonStyle())
                    Button("Run again") { Task { await model.start() } }.buttonStyle(PrimaryButtonStyle())
                }
            }
        }
    }
}
