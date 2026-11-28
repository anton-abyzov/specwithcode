import Testing
@testable import SWCFeatures
@testable import SWCSync

@MainActor
@Suite("Long lists keep their place")
struct ListScrollTests {
  /// The row of a project on two machines keeps its identity when the copy
  /// that leads it changes, so the list does not remove and re-insert it.
  @Test func aProjectRowKeepsItsIdentityWhenAnotherCopyLeads() {
    let m4 = ProjectRef(environmentId: "m4", projectId: "p")
    let m5 = ProjectRef(environmentId: "m5", projectId: "p")
    var led = ProjectSummary(ref: m4, title: "SpecWeave", machineLabel: "m4", machineOnline: true)
    led.members = [ProjectMember(ref: m4, machineLabel: "m4", machineOnline: true), ProjectMember(ref: m5, machineLabel: "M5", machineOnline: true)]
    var other = ProjectSummary(ref: m5, title: "SpecWeave", machineLabel: "M5", machineOnline: true)
    other.members = [ProjectMember(ref: m5, machineLabel: "M5", machineOnline: true), ProjectMember(ref: m4, machineLabel: "m4", machineOnline: false)]
    #expect(led.rowKey == other.rowKey)
    let alone = ProjectSummary(ref: ProjectRef(environmentId: "m4", projectId: "q"), title: "Other", machineLabel: "m4", machineOnline: true)
    #expect(alone.rowKey != led.rowKey)
  }

  /// A linked project keeps its row while its copies load one machine at a time.
  @Test func aLinkedProjectRowKeepsItsIdentityWhileCopiesLoad() {
    let m4 = ProjectRef(environmentId: "m4", projectId: "p")
    let m5 = ProjectRef(environmentId: "m5", projectId: "p")
    var first = ProjectSummary(ref: m4, title: "SpecWeave", machineLabel: "m4", machineOnline: true)
    first.logicalProjectId = "logical-1"
    var both = ProjectSummary(ref: m5, title: "SpecWeave", machineLabel: "M5", machineOnline: true)
    both.logicalProjectId = "logical-1"
    both.members = [ProjectMember(ref: m5, machineLabel: "M5", machineOnline: true), ProjectMember(ref: m4, machineLabel: "m4", machineOnline: true)]
    #expect(first.rowKey == both.rowKey)
  }

  /// The drawer's folds live in the router, so closing and opening it keeps them.
  @Test func theDrawerRemembersItsFoldsAndOffset() {
    let router = AppRouter()
    router.drawerFolds.allRecents = true
    router.drawerScrollOffset = 640
    router.isDrawerOpen = true
    router.isDrawerOpen = false
    #expect(router.drawerFolds.allRecents)
    #expect(router.drawerScrollOffset == 640)
  }
}
