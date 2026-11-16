import Testing
@testable import SqueakMacCore

@Suite("Layout solver")
struct PaneLayoutSolverTests {
    typealias P = PaneLayoutSolver.Pane
    let side = { (shown: Bool, w: Double) in P(shown: shown, preferred: w, range: PaneWidths.sidebarRange) }
    let right = { (shown: Bool, w: Double) in P(shown: shown, preferred: w, range: PaneWidths.inspectorRange) }

    private func check(_ r: PaneLayoutSolver.Result, _ window: Double) {
        #expect(r.sidebar + r.centre + r.right <= window + 0.001)
    }

    @Test func ownersCase() {
        let r = PaneLayoutSolver.solve(window: 1512, sidebar: side(true, 270), right: right(true, 900))
        check(r, 1512)
        #expect(r.centre >= PaneWidths.centreMin)
        #expect(r.right == 560 && r.sidebar == 270)
    }
    @Test func rightYieldsFirstThenSidebar() {
        let r = PaneLayoutSolver.solve(window: 960, sidebar: side(true, 360), right: right(true, 560))
        check(r, 960)
        #expect(r.right == 280 && r.sidebar == 260 && r.centre == 420)
        let t = PaneLayoutSolver.solve(window: 900, sidebar: side(true, 360), right: right(true, 560))
        #expect(t.sidebar == 200 && t.right == 280 && t.centre == 420)
    }
    @Test func tinyWindowsHideRightThenSidebar() {
        let r = PaneLayoutSolver.solve(window: 700, sidebar: side(true, 256), right: right(true, 400))
        check(r, 700)
        #expect(!r.rightShown && r.sidebarShown && r.centre >= 420)
        let t = PaneLayoutSolver.solve(window: 500, sidebar: side(true, 256), right: right(true, 400))
        #expect(!t.sidebarShown && !t.rightShown && t.centre == 500)
    }
    @Test func restoredOversizedValues() {
        for w in stride(from: 0.0, through: 3000, by: 37) {
            let r = PaneLayoutSolver.solve(window: w, sidebar: side(true, 5000), right: right(true, 9000))
            check(r, w)
            #expect(r.sidebar <= 360 && r.right <= 560)
        }
        let n = PaneLayoutSolver.solve(window: 1400, sidebar: side(true, .nan), right: right(true, -4))
        check(n, 1400)
    }
    @Test func hiddenZonesTakeNothing() {
        let r = PaneLayoutSolver.solve(window: 1200, sidebar: side(false, 300), right: right(false, 500))
        #expect(r.sidebar == 0 && r.right == 0 && r.centre == 1200)
    }
    @Test func dragMaxAndMinimumWindow() {
        #expect(PaneLayoutSolver.dragMax(window: 1512, otherPane: 270, range: PaneWidths.inspectorRange) == 560)
        #expect(PaneLayoutSolver.dragMax(window: 960, otherPane: 360, range: PaneWidths.inspectorRange) == 280)
        #expect(PaneLayoutSolver.minimumWindowWidth(sidebarShown: true, rightShown: true) == 900)
        #expect(PaneLayoutSolver.minimumWindowWidth(sidebarShown: false, rightShown: false) == 420)
    }
}

@Suite("Tab strip fit")
struct TabStripFitTests {
    @Test func hintDropsFirst() {
        #expect(!TabStripFit.showsAccessory(strip: 330, tabs: 2, leading: 44, accessory: 270))
        #expect(TabStripFit.showsAccessory(strip: 900, tabs: 2, leading: 44, accessory: 270))
        #expect(!TabStripFit.showsAccessory(strip: 0, tabs: 0, leading: 44, accessory: 270))
        #expect(TabStripFit.tabMin >= ChatTabWidth.closeSlot + TabStripFit.titleMin)
    }
}
