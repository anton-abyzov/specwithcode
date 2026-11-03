import Foundation
import Testing
@testable import SWCFeatures
import SWCSync
import SwiftUI
import Weave

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

  private func besideRouter() -> AppRouter {
    let router = AppRouter()
    router.showsCoordinatorBeside = true
    return router
  }

  @Test func theColumnHoldsTheOpenThreadsCoordinator() throws {
    let model = model()
    let router = besideRouter()
    #expect(router.besideCoordinator(in: model) == nil)

    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    router.select(.chat(.project(project.ref)))
    #expect(router.besideCoordinator(in: model) == nil)

    router.select(.chat(.thread(thread.ref)))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))

    // A thread pushed from the coordinator counts the same.
    router.select(.chat(.project(project.ref)))
    router.push(.chat(.thread(thread.ref)))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))

    // A screen without a chat goes back to the list.
    router.push(.overview(project.ref))
    #expect(router.besideCoordinator(in: model) == nil)
  }

  @Test func theThreadsModeLastsWhileThreadsChange() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    router.select(.chat(.thread(thread.ref)))

    router.showsCoordinatorBeside = false
    #expect(router.besideCoordinator(in: model) == nil)
    #expect(router.openThreadCoordinator(in: model) == .project(project.ref))

    router.select(.chat(.thread(thread.ref)))
    router.open(.thread(thread.ref))
    #expect(!router.showsCoordinatorBeside)
    router.showsCoordinatorBeside = true
    #expect(router.besideCoordinator(in: model) == .project(project.ref))
  }

  @Test func bothColumnsAreAlwaysAboutTheSameProject() throws {
    let model = model()
    let router = besideRouter()
    let projects = model.projects.filter { !model.threads(in: $0.ref).isEmpty && $0.ref != model.aide?.ref }
    let project = try #require(projects.first)
    let thread = try #require(model.threads(in: project.ref).first)
    router.open(.thread(thread.ref))
    #expect(router.sidebarScope(in: model) == project.ref)

    router.sidebarShowsAllProjects = true
    #expect(router.sidebarScope(in: model) == nil)
    #expect(router.besideCoordinator(in: model) == nil)

    let other = try #require(model.projects.first { $0.ref != project.ref && $0.ref != model.aide?.ref })
    router.showProject(other.ref, in: model)
    #expect(!router.sidebarShowsAllProjects)
    #expect(router.sidebarScope(in: model) == other.ref)
    #expect(router.followedProject(in: model) == other.ref)
    #expect(router.sidebarSelection(in: model) == .chat(.project(other.ref)))

    router.open(.thread(thread.ref))
    #expect(router.sidebarScope(in: model) == project.ref)
  }

  @Test func goingBackIntoTheOpenProjectLeavesItsChatAlone() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty && $0.ref != model.aide?.ref })
    let thread = try #require(model.threads(in: project.ref).first)
    router.open(.thread(thread.ref))
    router.sidebarShowsAllProjects = true

    router.showProject(project.ref, in: model)
    #expect(!router.sidebarShowsAllProjects)
    #expect(router.sidebarSelection(in: model) == .chat(.thread(thread.ref)))
  }

  @Test func allProjectsEndsWhenAChatOpens() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    router.open(.thread(thread.ref))
    router.sidebarShowsAllProjects = true

    router.select(.chat(.project(project.ref)))
    #expect(!router.sidebarShowsAllProjects)
    router.open(.thread(thread.ref))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))

    router.sidebarShowsAllProjects = true
    router.select(.machine(thread.ref.environmentId))
    #expect(router.sidebarShowsAllProjects)
  }

  @Test func theListKeepsItsScopeOnScreensWithoutAProject() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty && $0.ref != model.aide?.ref })
    let thread = try #require(model.threads(in: project.ref).first)
    router.open(.thread(thread.ref))

    router.push(.machines)
    #expect(router.sidebarScope(in: model) == project.ref)
    router.main.path = [.machine(thread.ref.environmentId)]
    #expect(router.sidebarScope(in: model) == project.ref)
    router.main.path = [.overview(project.ref)]
    #expect(router.sidebarScope(in: model) == project.ref)
    router.main.path = [.chat(.thread(ThreadRef(environmentId: thread.ref.environmentId, threadId: "subagent-child")))]
    #expect(router.sidebarScope(in: model) == project.ref)
  }

  @Test func onlyAOneSidedRegionIsAStatusRail() {
    #expect(EdgeInsets(top: 0, leading: 0, bottom: 34, trailing: 84).hasStatusRail)
    #expect(EdgeInsets(top: 0, leading: 84, bottom: 34, trailing: 0).hasStatusRail)
    #expect(!EdgeInsets(top: 0, leading: 59, bottom: 21, trailing: 59).hasStatusRail)
    #expect(!EdgeInsets(top: 59, leading: 0, bottom: 34, trailing: 0).hasStatusRail)
  }

  @Test func anAideThreadShowsTheWholeTree() throws {
    let model = model()
    let router = besideRouter()
    let aide = try #require(model.aide)
    let source = try #require(model.recentThreads.first)
    var thread = source
    thread.projectRef = aide.ref
    model.threadsByProject = [aide.ref: [thread]]
    model.recentThreads = [thread]
    router.open(.thread(thread.ref))
    #expect(router.sidebarScope(in: model) == nil)

    router.main.path = [.chat(.thread(thread.ref))]
    #expect(router.sidebarScope(in: model) == nil)
  }

  @Test func theMachineChipFiltersUntilItsMachineIsGone() throws {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    let router = besideRouter()
    router.sidebarShowsAllProjects = true
    let machine = try #require(model.machines.first { id in model.recentThreads.contains { $0.ref.environmentId == id.id } })
    let unfiltered = router.sidebarThreads(in: model).count

    router.sidebarMachine = machine.id
    let filtered = router.sidebarThreads(in: model)
    #expect(!filtered.isEmpty)
    #expect(filtered.count < unfiltered)
    #expect(filtered.allSatisfy { $0.ref.environmentId == machine.id })

    router.sidebarMachine = "gone"
    #expect(router.activeSidebarMachine(in: model) == nil)
    #expect(router.sidebarThreads(in: model).count == unfiltered)

    router.sidebarMachine = machine.id
    model.machines = [machine]
    #expect(router.activeSidebarMachine(in: model) == nil)
  }

  @Test func aStatusChangeNeverMovesARow() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { project in
      project.ref != model.aide?.ref && model.threads(in: project.ref).filter { !$0.isResolved && !$0.isPinned }.count > 1
    })
    let threads = try #require(model.threadsByProject[project.ref])
    let thread = try #require(threads.first)
    router.open(.thread(thread.ref))
    let before = router.sidebarThreads(in: model).map(\.ref)

    // The oldest listed row: a sort by update would bring it to the top.
    let lastRef = try #require(before.last)
    #expect(before.count > 1)
    var moved = try #require(threads.first { $0.ref == lastRef })
    let asked = moved.activityAt
    moved.activity = .needsYou
    moved.updatedAt = Date().addingTimeInterval(3_600)
    #expect(moved.activityAt == asked)
    model.threadsByProject[project.ref] = ShellSummaries.sortThreads(threads.filter { $0.ref != lastRef } + [moved])
    #expect(try #require(model.threadsByProject[project.ref]?.first { !$0.isPinned }).ref == lastRef)
    #expect(router.sidebarThreads(in: model).map(\.ref) == before)
  }

  @Test func everyThreadStateHasItsOwnMark() throws {
    var thread = try #require(model().recentThreads.first)
    thread.machineOnline = true
    thread.waitsOnUser = false
    thread.isDone = false
    thread.activity = .needsYou
    #expect(ThreadStatusMark.state(of: thread) == .needsYou)
    thread.activity = .working
    #expect(ThreadStatusMark.state(of: thread) == .working)
    thread.activity = .failed
    #expect(ThreadStatusMark.state(of: thread) == .failed)
    thread.activity = .idle
    #expect(ThreadStatusMark.state(of: thread) == .idle)
    thread.isDone = true
    #expect(ThreadStatusMark.state(of: thread) == .done)
    thread.waitsOnUser = true
    #expect(ThreadStatusMark.state(of: thread) == .needsYou)

    // A dependency wait is working, in the mark and the group alike.
    thread.waitsOnUser = false
    thread.isDone = false
    thread.waitReason = "Waiting for CI"
    #expect(ThreadStatusMark.state(of: thread) == .working)
    #expect(ThreadGroups([thread]).working.count == 1)
    thread.waitReason = nil

    // Marks and chips agree about a thread on an offline machine.
    thread.machineOnline = false
    thread.activity = .working
    #expect(ThreadStatusMark.state(of: thread) == .offline)
    #expect(ThreadGroups([thread]).offline.count == 1)
    thread.isResolved = true
    #expect(ThreadGroups([thread]).resolved.count == 1)
  }

  @Test func everyWayIntoAChatEndsAllProjects() throws {
    let model = model()
    let router = besideRouter()
    let thread = try #require(model.recentThreads.first)
    router.sidebarShowsAllProjects = true
    router.push(.chat(.thread(thread.ref)))
    #expect(!router.sidebarShowsAllProjects)

    router.main.path = []
    router.sidebarShowsAllProjects = true
    router.pushThread(thread.ref, on: router.main, in: model)
    #expect(!router.sidebarShowsAllProjects)

    router.sidebarShowsAllProjects = true
    router.push(.machines)
    #expect(router.sidebarShowsAllProjects)
  }

  @Test func aThreadInNoListKeepsTheChatItWasOpenedFrom() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let child = ThreadRef(environmentId: thread.ref.environmentId, threadId: "subagent-child")
    #expect(model.thread(child) == nil)

    router.select(.chat(.project(project.ref)))
    router.push(.chat(.thread(child)))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))

    router.select(.chat(.thread(thread.ref)))
    router.push(.chat(.thread(child)))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))
  }

  @Test func aLinkWithNoOpenerGetsNoCoordinatorFromTheRoot() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let child = ThreadRef(environmentId: thread.ref.environmentId, threadId: "subagent-child")

    router.handle(.thread(thread.ref))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))
    router.handle(.thread(child))
    #expect(router.besideCoordinator(in: model) == nil)

    // Opened by hand from the root, the same thread has an opener again.
    router.select(.chat(.project(project.ref)))
    router.push(.chat(.thread(child)))
    #expect(router.besideCoordinator(in: model) == .project(project.ref))
  }

  @Test func aThreadInNoListFollowsTheScreenItWasOpenedFrom() throws {
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let machine = try #require(model.machines.first)
    let child = ThreadRef(environmentId: project.ref.environmentId, threadId: "subagent-child")

    router.main.path = [.overview(project.ref), .chat(.thread(child))]
    #expect(router.besideCoordinator(in: model) == .project(project.ref))
    router.main.path = [.machine(machine.id), .chat(.thread(child))]
    #expect(router.besideCoordinator(in: model) == nil)
  }

  @Test func switchingTheRootForgetsTheColumnsChoice() throws {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    let router = besideRouter()
    let project = try #require(model.projects.first { $0.members.count > 1 && !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let chosen = try #require(project.members.first)
    let root = try #require(project.members.last)
    router.select(.chat(.thread(thread.ref)))
    router.chosenCoordinator = chosen.ref

    router.open(.thread(thread.ref))
    #expect(router.chosenCoordinator == chosen.ref)
    router.open(.project(root.ref))
    #expect(router.chosenCoordinator == nil)
    router.push(.chat(.thread(thread.ref)))
    #expect(router.besideCoordinator(in: model) == .project(root.ref))
  }

  @Test func theColumnsSwitcherLeavesTheThreadOpen() throws {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    engine.streamDelay = .zero
    let model = AppModel(engine: engine)
    let router = besideRouter()
    let project = try #require(model.projects.first { $0.members.count > 1 && !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let other = try #require(project.members.first { .project($0.ref) != router.besideCoordinator(in: model) && $0.ref != thread.projectRef })
    router.select(.chat(.thread(thread.ref)))

    router.chosenCoordinator = other.ref
    #expect(router.besideCoordinator(in: model) == .project(other.ref))
    #expect(router.root == .thread(thread.ref))
    #expect(router.sidebarSelection(in: model) == .chat(.thread(thread.ref)))
  }

  @Test func theOpenThreadIsNotPushedOntoItself() throws {
    let model = model()
    let router = AppRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    router.select(.chat(.thread(thread.ref)))
    router.pushThread(thread.ref, on: router.main, in: model)
    #expect(router.main.path.isEmpty)
  }

  @Test func theSettingKeepsTheListAndIsRemembered() throws {
    let saved = UserDefaults.standard.object(forKey: AppRouter.coordinatorBesideKey)
    defer { UserDefaults.standard.set(saved, forKey: AppRouter.coordinatorBesideKey) }
    let model = model()
    let router = besideRouter()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    router.select(.chat(.thread(try #require(model.threads(in: project.ref).first).ref)))

    router.showsCoordinatorBeside = false
    #expect(router.besideCoordinator(in: model) == nil)
    #expect(AppRouter().showsCoordinatorBeside == false)
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
