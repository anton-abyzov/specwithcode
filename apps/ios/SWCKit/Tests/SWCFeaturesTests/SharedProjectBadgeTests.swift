import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Shared project badge")
struct SharedProjectBadgeTests {
  private let names = ["env-m4max": "M4 Max", "env-ministorm": "Ministorm", "env-m4": "M4", "env-m1": "M1"]
  private func name(_ id: String) -> String { names[id] ?? "another machine" }

  private func project(_ here: String, members: [(String, Bool)] = [], linked: [String] = [], coordinatorElsewhere: String? = nil, kind: ProjectKind = .code) -> ProjectSummary {
    var project = ProjectSummary(
      ref: ProjectRef(environmentId: here, projectId: "p"),
      title: "specweave",
      kind: kind,
      machineLabel: name(here),
      machineOnline: true,
      members: members.map { ProjectMember(ref: ProjectRef(environmentId: $0.0, projectId: "p"), machineLabel: name($0.0), machineOnline: true, isLinked: $0.1) }
    )
    project.linkedMachineIds = linked
    project.coordinatorElsewhereId = coordinatorElsewhere
    return project
  }

  @Test func linkedProjectIsSharedFromTheRowsMachine() throws {
    let badge = try #require(SharedProjectBadge.of(project("env-m4max", members: [("env-m4max", true), ("env-ministorm", true)]), nameOf: name))
    #expect(badge.role == .coordinator)
    #expect(badge.symbol == "point.3.connected.trianglepath.dotted")
    #expect(badge.label == "Shared from M4 Max with Ministorm")
  }

  @Test func sameRepositoryCopiesThatAreNotLinkedShowNothing() {
    #expect(SharedProjectBadge.of(project("env-m4", members: [("env-m4", false), ("env-m1", false)]), nameOf: name) == nil)
    #expect(SharedProjectBadge.of(project("env-m4"), nameOf: name) == nil)
  }

  @Test func onePairedMachineStillShowsALinkedProject() throws {
    // Only M4 Max is paired: the other member comes from the linked project's own list.
    let badge = try #require(SharedProjectBadge.of(project("env-m4max", members: [("env-m4max", true)], linked: ["env-m4max", "env-ministorm"]), nameOf: name))
    #expect(badge.label == "Shared from M4 Max with Ministorm")
    let unknown = try #require(SharedProjectBadge.of(project("env-m4max", linked: ["env-elsewhere"]), nameOf: name))
    #expect(unknown.label == "Shared from M4 Max with another machine")
  }

  @Test func handedOffCopyNamesWhereItsCoordinatorRuns() throws {
    let badge = try #require(SharedProjectBadge.of(project("env-ministorm", members: [("env-ministorm", true)], linked: ["env-m4max"], coordinatorElsewhere: "env-m4max"), nameOf: name))
    #expect(badge.role == .workers)
    #expect(badge.symbol == "arrow.left.arrow.right")
    #expect(badge.label == "Handed off: coordinator on M4 Max, Ministorm runs workers")
  }

  @Test func personalProjectWearsNoBadge() {
    #expect(SharedProjectBadge.of(project("env-m4max", linked: ["env-ministorm"], kind: .personal), nameOf: name) == nil)
  }
}
