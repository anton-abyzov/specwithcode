import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Chat kind line")
struct ChatKindTests {
  private func model(_ scenario: FixtureScenario = .default) -> AppModel {
    let engine = FixtureEngine(scenario: scenario)
    engine.latency = .zero
    engine.streamDelay = .zero
    return AppModel(engine: engine)
  }

  @Test func aCoordinatorSaysWhoseCoordinatorItIs() throws {
    let model = model()
    let project = try #require(model.projects.first)
    let line = try #require(ChatKindLine.make(for: .project(project.ref), machine: "m4", in: model))
    #expect(line.kind == .coordinator)
    // The title above already names the project; the line keeps the machine.
    #expect(line.text == "Coordinator · m4")
    #expect(line.symbol == "point.3.filled.connected.trianglepath.dotted")
    #expect(line.coordinatorHint == nil)
    #expect(ChatKindLine.make(for: .project(project.ref), machine: "", in: model)?.text == "Coordinator")
  }

  @Test func aWorkerThreadNamesItsProject() throws {
    let model = model()
    let project = try #require(model.projects.first { $0.kind != .personal && !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let coordinator = AppRouter().coordinator(returningFrom: thread.ref, in: model)
    let line = try #require(ChatKindLine.make(for: .thread(thread.ref), machine: "m4", coordinator: coordinator, in: model))
    #expect(line.kind == .thread)
    #expect(line.text == "Thread in \(project.title)")
    #expect(line.shortText == "In \(project.title)")
    #expect(line.symbol == "text.bubble")
    #expect(line.coordinatorHint == "Opens the \(project.title) coordinator")
  }

  @Test func aThreadWithoutAProjectIsJustAThread() throws {
    let model = model()
    let ref = ThreadRef(environmentId: "env-loose", threadId: "loose")
    model.recentThreads.append(ThreadSummary(ref: ref, title: "Loose", activity: .idle, updatedAt: Date(), machineLabel: "M4", machineOnline: true))
    let line = try #require(ChatKindLine.make(for: .thread(ref), machine: "M4", in: model))
    #expect(line == ChatKindLine(kind: .thread, text: "Thread", coordinatorHint: nil))
    #expect(AppRouter().coordinator(returningFrom: ref, in: model) == nil)
  }

  @Test func aideKeepsItsOwnSubtitle() throws {
    let model = model()
    let aide = try #require(model.aide)
    #expect(ChatKindLine.make(for: .aide(aide.ref), machine: "M4", in: model) == nil)
  }

  @Test func theLineGoesBackToTheThreadsCoordinator() throws {
    let model = model()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let router = AppRouter()
    #expect(router.coordinator(returningFrom: thread.ref, in: model) == .project(project.ref))

    // On a phone the thread was pushed over its coordinator: back pops to it.
    router.open(.project(project.ref))
    router.push(.chat(.thread(thread.ref)))
    router.returnToCoordinator(from: thread.ref, on: router.main, wide: false, in: model)
    #expect(router.main.path.isEmpty)
    #expect(router.root == .project(project.ref))

    // Opened on its own, the thread's coordinator replaces it.
    router.open(.thread(thread.ref))
    router.returnToCoordinator(from: thread.ref, on: router.main, wide: false, in: model)
    #expect(router.root == .project(project.ref))
    #expect(router.main.path.isEmpty)
  }

  @Test func besideTheColumnTheCoordinatorTakesFocusInPlace() throws {
    let model = model()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let router = AppRouter()
    router.showsCoordinatorBeside = true
    router.select(.chat(.project(project.ref)))
    router.push(.chat(.thread(thread.ref)))
    router.widePanes = .detail

    router.returnToCoordinator(from: thread.ref, on: router.main, wide: true, in: model)
    // The thread stays open; the column with its coordinator comes back.
    #expect(router.sidebarSelection(in: model) == .chat(.thread(thread.ref)))
    #expect(router.widePanes == .both)
    #expect(router.pendingComposerFocus == .project(project.ref))
  }

  @Test func aLinkedProjectGoesBackToItsActiveCoordinatorOnAnotherMachine() throws {
    let model = model(.fleet)
    let project = try #require(model.projects.first { $0.members.count > 1 && !model.threads(in: $0.ref).isEmpty })
    let active = try #require(project.members.first { $0.isCoordinator })
    // A thread that lives on a machine other than the active coordinator's.
    let thread = try #require(model.threads(in: project.ref).first { $0.ref.environmentId != active.ref.environmentId })
    #expect(ChatKindLine.make(for: .thread(thread.ref), machine: "", coordinator: .project(active.ref), in: model)?.text == "Thread in \(project.title)")
    #expect(AppRouter().coordinator(returningFrom: thread.ref, in: model) == .project(active.ref))

    // The machine picked in the column's switcher wins, as it does beside the thread.
    let router = AppRouter()
    router.showsCoordinatorBeside = true
    let other = try #require(project.members.first { $0.ref != active.ref })
    router.select(.chat(.thread(thread.ref)))
    router.chosenCoordinator = other.ref
    #expect(router.coordinator(returningFrom: thread.ref, in: model) == .project(other.ref))
  }

  @Test func aSubagentChildKeepsItsProjectAndItsWayBack() throws {
    let model = model()
    let project = try #require(model.projects.first { $0.kind != .personal })
    // A subagent's child or an archived thread is in no list; the session knows its project.
    let child = ThreadRef(environmentId: project.ref.environmentId, threadId: "subagent-child")
    #expect(model.thread(child) == nil)
    #expect(ChatKindLine.make(for: .thread(child), machine: "m4", projectTitle: project.title, in: model)
      == ChatKindLine(kind: .thread, text: "Thread in \(project.title)", shortText: "In \(project.title)", coordinatorHint: nil))

    // Opened from its coordinator, the walk still finds the way back.
    let router = AppRouter()
    router.open(.project(project.ref))
    router.push(.chat(.thread(child)))
    let coordinator = try #require(router.coordinator(returningFrom: child, in: model))
    #expect(coordinator == .project(project.ref))
    let line = try #require(ChatKindLine.make(for: .thread(child), machine: "m4", coordinator: coordinator, in: model))
    #expect(line.text == "Thread in \(project.title)")
    #expect(line.coordinatorHint == "Opens the \(project.title) coordinator")
    router.returnToCoordinator(from: child, on: router.main, wide: false, in: model)
    #expect(router.main.path.isEmpty)
    #expect(router.root == .project(project.ref))
  }

  @Test func aThreadWhoseMachineControlIsInTheRailNamesItsMachine() throws {
    let model = model()
    let project = try #require(model.projects.first { $0.kind != .personal && !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let line = try #require(ChatKindLine.make(for: .thread(thread.ref), machine: "m4", namesMachine: true, in: model))
    #expect(line.text == "Thread in \(project.title) · m4")
    #expect(line.shortText == "In \(project.title) · m4")
    #expect(ChatKindLine.make(for: .thread(thread.ref), machine: "m4", in: model)?.text == "Thread in \(project.title)")
  }

  @Test func aPersonalProjectsThreadNamesItsMachine() throws {
    let model = model()
    let aide = try #require(model.aide)
    let thread = ThreadSummary(ref: ThreadRef(environmentId: aide.ref.environmentId, threadId: "aide-thread"), projectRef: aide.ref, projectTitle: aide.title, title: "Errand", activity: .idle, updatedAt: Date(), machineLabel: "m4", machineOnline: true)
    model.recentThreads.append(thread)
    let coordinator = AppRouter().coordinator(returningFrom: thread.ref, in: model)
    #expect(coordinator == .aide(aide.ref))
    let line = try #require(ChatKindLine.make(for: .thread(thread.ref), machine: "m4", coordinator: coordinator, in: model))
    #expect(line.text == "Thread in \(aide.title) · m4")
    #expect(line.shortText == "In \(aide.title) · m4")
    #expect(line.coordinatorHint == "Opens \(aide.title)")
  }

  @Test func fromAllProjectsTheCoordinatorReplacesTheThread() throws {
    let model = model()
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    let thread = try #require(model.threads(in: project.ref).first)
    let router = AppRouter()
    router.showsCoordinatorBeside = true
    router.select(.chat(.thread(thread.ref)))
    router.sidebarShowsAllProjects = true
    #expect(router.besideCoordinator(in: model) == nil)

    router.returnToCoordinator(from: thread.ref, on: router.main, wide: true, in: model)
    #expect(router.sidebarSelection(in: model) == .chat(.project(project.ref)))
  }
}
