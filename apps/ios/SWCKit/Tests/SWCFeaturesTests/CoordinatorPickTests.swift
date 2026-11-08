import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Coordinator pick")
struct CoordinatorPickTests {
  private func fleet() -> AppModel {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    engine.streamDelay = .zero
    return AppModel(engine: engine)
  }

  private func store() throws -> CoordinatorPickStore {
    CoordinatorPickStore(defaults: try #require(UserDefaults(suiteName: "coordinator-pick-\(UUID().uuidString)")))
  }

  private func linked(_ model: AppModel) throws -> (ProjectSummary, ProjectMember) {
    let project = try #require(model.projects.first { $0.members.count > 1 && !model.threads(in: $0.ref).isEmpty })
    let other = try #require(project.members.first { $0.ref != project.ref })
    return (project, other)
  }

  @Test func withoutAPickTheRowOpensTheActiveCoordinator() throws {
    let model = fleet()
    let (project, _) = try linked(model)
    let router = AppRouter(coordinatorPicks: try store(), model: model)
    router.open(.project(project.ref))
    #expect(router.root == .project(project.ref))
  }

  @Test func thePickedMachineComesBackAfterOtherChats() throws {
    let model = fleet()
    let (project, other) = try linked(model)
    let router = AppRouter(coordinatorPicks: try store(), model: model)
    router.open(.project(project.ref))
    router.chooseCoordinator(other.ref, besideThread: false, in: model)
    #expect(router.root == .project(other.ref))

    let thread = try #require(model.threads(in: project.ref).first)
    router.open(.thread(thread.ref))
    if let elsewhere = model.projects.first(where: { $0.ref != project.ref && !$0.archived }) { router.open(.project(elsewhere.ref)) }
    router.open(.project(project.ref))
    #expect(router.root == .project(other.ref))
  }

  @Test func thePickSurvivesARelaunch() throws {
    let model = fleet()
    let (project, other) = try linked(model)
    let picks = try store()
    AppRouter(coordinatorPicks: picks, model: model).chooseCoordinator(other.ref, besideThread: false, in: model)

    let relaunched = AppRouter(coordinatorPicks: CoordinatorPickStore(defaults: picks.defaults), model: model)
    relaunched.open(.project(project.ref))
    #expect(relaunched.root == .project(other.ref))
  }

  @Test func pickingTheActiveCoordinatorAgainSticks() throws {
    let model = fleet()
    let (project, other) = try linked(model)
    let router = AppRouter(coordinatorPicks: try store(), model: model)
    router.chooseCoordinator(other.ref, besideThread: false, in: model)
    router.chooseCoordinator(project.ref, besideThread: false, in: model)
    router.open(.project(project.ref))
    #expect(router.root == .project(project.ref))
  }

  @Test func theColumnBesideAThreadUsesThePick() throws {
    let model = fleet()
    let (project, other) = try linked(model)
    let router = AppRouter(coordinatorPicks: try store(), model: model)
    router.showsCoordinatorBeside = true
    let thread = try #require(model.threads(in: project.ref).first)
    router.chooseCoordinator(other.ref, besideThread: true, in: model)
    router.open(.thread(thread.ref))
    #expect(router.besideCoordinator(in: model) == .project(other.ref))
  }

  @Test func aCopyThatLeftTheProjectFallsBack() throws {
    let model = fleet()
    var (project, other) = try linked(model)
    let picks = try store()
    picks.save(other.ref, for: project)
    #expect(picks.pick(for: project) == other.ref)
    project.members.removeAll { $0.ref == other.ref }
    #expect(picks.pick(for: project) == nil)
  }

  @Test func thePickFollowsTheProjectWhicheverCopyLeadsTheRow() throws {
    let model = fleet()
    let (project, other) = try linked(model)
    let picks = try store()
    picks.save(other.ref, for: project)
    var reordered = project
    reordered.members.reverse()
    #expect(CoordinatorPickStore.projectKey(reordered) == CoordinatorPickStore.projectKey(project))
    #expect(picks.pick(for: reordered) == other.ref)
  }
}
