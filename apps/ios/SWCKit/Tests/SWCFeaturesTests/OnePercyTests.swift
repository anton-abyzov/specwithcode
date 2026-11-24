import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

/// One Percy for linked machines (1448 AC-14), on the `one-percy` sample
/// data: Studio and Laptop hold linked seats, Desktop's assistant never joined.
@MainActor
@Suite("One Percy")
struct OnePercyFeatureTests {
  let studio = ProjectRef(environmentId: "env-studio", projectId: "percy")
  let laptop = ProjectRef(environmentId: "env-laptop", projectId: "percy")
  let desktop = ProjectRef(environmentId: "env-desktop", projectId: "assistant")

  private func model(_ scenario: FixtureScenario = .onePercy, aide: Bool = true) -> AppModel {
    let engine = FixtureEngine(scenario: scenario, aideEnabled: aide)
    engine.latency = .zero
    engine.streamDelay = .zero
    return AppModel(engine: engine)
  }

  /// The linked row as it reads once `talk` is the seat the phone talks to.
  private func row(talk: ProjectRef, offline: Set<String> = []) -> ProjectSummary {
    let seats = [talk] + [studio, laptop].filter { $0 != talk }
    var row = ProjectSummary(ref: talk, title: "Percy", kind: .personal, machineLabel: talk == studio ? "Studio" : "Laptop", machineOnline: !offline.contains(talk.environmentId), members: seats.map {
      ProjectMember(ref: $0, machineLabel: $0 == studio ? "Studio" : "Laptop", machineOnline: !offline.contains($0.environmentId), isCoordinator: $0 == talk)
    })
    row.logicalProjectId = "percy-link"
    return row
  }

  private func show(_ row: ProjectSummary, in model: AppModel) {
    model.aide = row
    model.aideSeats = [row] + model.aideSeats.dropFirst()
  }

  @Test func theDrawerListsOnePercyAndTheAssistantThatDidNotJoin() throws {
    let model = model()
    #expect(model.aideSeats.map(\.aideRowTitle) == ["Percy", "Percy on Desktop"])
    #expect(model.aideSeats.map(\.aideRowSubtitle) == [nil, "not joined"])
    let percy = try #require(model.aide)
    // Studio runs the routines, so the phone talks to it.
    #expect(percy.ref == studio)
    #expect(percy.members.map(\.ref) == [studio, laptop])
    // Laptop's unread chat shows on the one row.
    #expect(percy.hasUnread)
    #expect(model.isAideSeat(laptop))
    #expect(model.project(laptop)?.ref == studio)
    #expect(model.project(desktop)?.ref == desktop)
  }

  @Test func percysChatsComeFromEverySeatNewestFirstWithTheirMachine() throws {
    let model = model()
    let chats = model.threads(in: studio)
    #expect(chats.map(\.title) == ["Plan the week", "Book flights to Lisbon", "Gift ideas for the team", "Renew the passport"])
    #expect(chats.map(\.placement.owner) == ["Studio", "Laptop", "Laptop", "Studio"])
    #expect(model.threads(in: laptop) == chats)
    // The list names each chat's machine, as the Topics screen shows it.
    let percy = try #require(model.aide)
    #expect(model.threadMachines(of: percy, threads: chats).map(\.name) == ["Studio", "Laptop"])
    #expect(ProjectOverviewView.note(chats[1], showsMachine: true) == "Laptop")
    #expect(model.threads(in: desktop).map(\.title) == ["Sort the old notes"])
    #expect(percy.aideOfflineLines.isEmpty)
  }

  @Test func anOfflineSeatIsOneQuietLine() throws {
    let model = model(.onePercyAway)
    let percy = try #require(model.aide)
    #expect(percy.ref == studio)
    #expect(percy.aideOfflineLines == ["Laptop is offline: its chats appear when it is back"])
    #expect(model.threads(in: studio).map(\.title) == ["Plan the week", "Renew the passport"])
    // Offline machines never make the phone offer a second Percy.
    #expect(!model.allMachinesLoaded)
  }

  @Test func turnedOffHidesEveryRow() {
    let model = model(aide: false)
    #expect(model.aide == nil)
    #expect(model.aideSeats.isEmpty)
  }

  @Test func percysRowIsSelectedOnWhicheverSeatItsChatIs() throws {
    let model = model()
    let router = AppRouter()
    let percy = try #require(model.aide)
    let own = try #require(model.aideSeats.last)
    #expect(router.landing(in: model) == .aide(studio))
    #expect(router.showsAide(percy, in: model))
    #expect(!router.showsAide(own, in: model))

    // A chat open on Laptop's seat stays there while Laptop is reachable.
    router.root = .aide(laptop)
    #expect(router.landing(in: model) == .aide(laptop))
    #expect(router.showsAide(percy, in: model))
    #expect(router.sidebarSelection(in: model) == .chat(.aide(laptop)))

    router.open(.aide(own.ref))
    #expect(router.showsAide(own, in: model))
    #expect(!router.showsAide(percy, in: model))
  }

  @Test func aNewChatGoesToTheSeatThePhoneTalksTo() throws {
    let model = model()
    let router = AppRouter()
    // From a chat that lives on Laptop, a new chat still goes to Studio.
    let chat = try #require(model.threads(in: studio).first { $0.ref.environmentId == laptop.environmentId })
    router.root = .thread(chat.ref)
    #expect(router.openAideSeat(in: model) == laptop)
    router.startNewChat(in: model)
    #expect(router.root == .aide(studio))

    // The chat itself opens on the machine that owns it.
    router.open(.thread(chat.ref))
    #expect(router.landing(in: model) == .thread(chat.ref))
    #expect(router.coordinator(returningFrom: chat.ref, in: model) == .aide(studio))

    // The assistant that did not join keeps its new chats.
    router.root = .aide(desktop)
    router.startNewChat(in: model)
    #expect(router.root == .aide(desktop))
  }

  @Test func anOpenChatMovesOnlyWhenItsMachineGoesOffline() throws {
    let model = model()
    let router = AppRouter()
    router.settleAideSeat(in: model)
    #expect(router.root == .aide(studio))

    // Studio drops: the phone talks to Laptop, and the open chat follows.
    show(row(talk: laptop, offline: [studio.environmentId]), in: model)
    #expect(router.landing(in: model) == .aide(laptop))
    router.settleAideSeat(in: model)
    #expect(router.root == .aide(laptop))

    // Studio is back and runs the routines again: the open chat stays on Laptop.
    show(row(talk: studio), in: model)
    router.settleAideSeat(in: model)
    #expect(router.landing(in: model) == .aide(laptop))
    #expect(router.root == .aide(laptop))
    // Its threads go back to the chat that is open, not to another seat's.
    let chat = try #require(model.threads(in: studio).first)
    router.push(.chat(.thread(chat.ref)))
    #expect(router.openThreadCoordinator(in: model) == .aide(laptop))
    router.main.path = []

    // Opening Percy again from its row is on the seat the phone talks to.
    router.open(.aide(try #require(model.aide).ref))
    #expect(router.landing(in: model) == .aide(studio))
  }

  @Test func aSavedSeatOpensOnTheSeatThePhoneTalksTo() throws {
    let model = model()
    #expect(AppRouter.onTalkSeat(.aide(laptop), in: model) == .aide(studio))
    #expect(AppRouter.onTalkSeat(.aide(desktop), in: model) == .aide(desktop))
    let project = try #require(model.projects.first)
    #expect(AppRouter.onTalkSeat(.project(project.ref), in: model) == .project(project.ref))
    #expect(AppRouter.isValid(.aide(laptop), in: model))
  }
}
