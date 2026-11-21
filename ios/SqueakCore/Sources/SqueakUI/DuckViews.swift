#if os(iOS)
import SqueakCore
import SwiftUI

/// Ducks own their branch (the Mac's `ducksOwnBranch` flag): a pond lists its ducks directly, each with where it works.
/// Everything here draws what `DuckPhone` (SqueakCore) decided; with the flag off none of it is on screen.

/// A duck's menu: Branch off, Work with…, Move to main. Offers nothing for a remote pond, a working duck or a chat
/// with no duck (the same rule the Mac applies).
struct DuckMenu: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session

    var body: some View {
        let moves = model.duckMoves(for: session)
        if moves.any {
            Button { Haptics.play(.tap); model.moveDuck(session, to: .new()) } label: { Label("Branch off", systemImage: "arrow.triangle.branch") }
            if !moves.joinTargets.isEmpty {
                Menu {
                    ForEach(moves.joinTargets) { target in
                        Button { Haptics.play(.tap); model.moveDuck(session, to: target.place) } label: {
                            Text(target.duckId == nil ? target.title : "\(target.title) \u{00B7} \(target.branch)")
                        }
                    }
                } label: { Label("Work with\u{2026}", systemImage: "person.2") }
            }
            if moves.moveToMain {
                Button { Haptics.play(.tap); model.moveDuck(session, to: .main) } label: { Label("Move to main", systemImage: "arrow.uturn.backward") }
            }
        }
    }
}

/// The ducks of a pond as list sections: newest first, or one section per branch.
struct DuckSections: View {
    @Environment(AppModel.self) private var model
    let item: PondItem
    let rows: [DuckPhone.Row]
    var grouped = false
    var limit: Int? = nil

    var body: some View {
        if rows.isEmpty {
            Section("Ducks") { Text("No ducks yet").foregroundStyle(Theme.muted).frame(minHeight: 44) }
        } else if grouped, !item.remote {
            ForEach(DuckPhone.groups(rows)) { group in
                Section {
                    ForEach(group.rows) { duckLink($0) }
                } header: { Text(group.label.isEmpty ? "Other" : group.label).font(.footnote.monospaced()) }
            }
        } else {
            Section("Ducks") {
                ForEach(limit.map { Array(rows.prefix($0)) } ?? rows) { duckLink($0) }
            }
        }
    }

    private func duckLink(_ row: DuckPhone.Row) -> some View {
        NavigationLink(value: HomeRoute.session(row.id)) {
            SessionRow(session: row.session, recent: false, inProject: true, branchLabel: row.label)
        }
        .tapHaptic(.navigate)
        .contextMenu { DuckMenu(session: row.session) }
    }
}
#endif
