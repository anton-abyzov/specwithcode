import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Sidebar selection")
struct SidebarSelectionTests {
  private func model() -> AppModel {
    let engine = FixtureEngine(scenario: .default)
    engine.latency = .zero
    engine.streamDelay = .zero
    return AppModel(engine: engine)
  }

  @Test func selectionFollowsTheRouter() throws {
    let model = model()
    let router = AppRouter()
    let aide = try #require(model.aide)
    #expect(router.sidebarSelection(in: model) == .chat(.aide(aide.ref)))

    let project = try #require(model.projects.first)
    router.select(.chat(.project(project.ref)))
    #expect(router.root == .project(project.ref))
    #expect(router.sidebarSelection(in: model) == .chat(.project(project.ref)))

    // A pushed screen has no sidebar row, so nothing stays highlighted.
    router.push(.overview(project.ref))
    #expect(router.sidebarSelection(in: model) == nil)
  }

  @Test func selectingAMachineReplacesTheStack() throws {
    let model = model()
    let router = AppRouter()
    let machine = try #require(model.machines.first)
    router.push(.machines)
    router.isDrawerOpen = true
    router.select(.machine(machine.id))
    #expect(router.main.path == [.machine(machine.id)])
    #expect(!router.isDrawerOpen)
    #expect(router.sidebarSelection(in: model) == .machine(machine.id))
    router.select(.chat(.aide(try #require(model.aide).ref)))
    #expect(router.main.path.isEmpty)
  }

  @Test func newChatOpensAideWithComposerFocus() throws {
    let model = model()
    let router = AppRouter()
    router.isDrawerOpen = true
    router.startNewChat(in: model)
    let aide = ChatTarget.aide(try #require(model.aide).ref)
    #expect(router.root == aide)
    #expect(router.pendingComposerFocus == aide)
    #expect(!router.isDrawerOpen)
  }
}
