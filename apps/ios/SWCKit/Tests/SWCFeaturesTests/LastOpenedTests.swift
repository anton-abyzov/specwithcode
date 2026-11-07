import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Last opened")
struct LastOpenedTests {
  private func model(_ scenario: FixtureScenario = .default) -> AppModel {
    let engine = FixtureEngine(scenario: scenario)
    engine.latency = .zero
    engine.streamDelay = .zero
    return AppModel(engine: engine)
  }

  /// A store over its own defaults, so tests never share or leave state.
  private func store() -> LastOpenedStore {
    let name = "swc.lastOpened.test.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return LastOpenedStore(defaults: defaults)
  }

  /// A project that is not the default landing, and one of its threads.
  private func projectWithThread(in model: AppModel) throws -> (ProjectRef, ThreadRef) {
    let project = try #require(model.projects.first { !model.threads(in: $0.ref).isEmpty })
    return (project.ref, try #require(model.threads(in: project.ref).first).ref)
  }

  @Test func openSavesRoot() throws {
    let model = model()
    let store = store()
    let router = AppRouter(lastOpenedStore: store)
    let (project, _) = try projectWithThread(in: model)
    router.open(.project(project))
    #expect(store.load() == LastOpened(root: .project(project), thread: nil))
  }

  @Test func pushThreadSavesThreadAndPopClearsIt() throws {
    let model = model()
    let store = store()
    let router = AppRouter(lastOpenedStore: store)
    let (project, thread) = try projectWithThread(in: model)
    router.open(.project(project))
    router.pushThread(thread, on: router.main, in: model)
    #expect(store.load() == LastOpened(root: .project(project), thread: thread))
    router.main.pop()
    #expect(store.load() == LastOpened(root: .project(project), thread: nil))
  }

  @Test func coldLaunchRestoresProjectAndThread() throws {
    let model = model()
    let store = store()
    let (project, thread) = try projectWithThread(in: model)
    store.save(LastOpened(root: .project(project), thread: thread))

    let router = AppRouter(lastOpenedStore: store)
    router.pendingRestore = store.load()
    #expect(router.applyRestore(in: model))
    #expect(router.root == .project(project))
    #expect(router.main.path == [.chat(.thread(thread))])
    #expect(router.pendingRestore == nil)
    #expect(store.load() == LastOpened(root: .project(project), thread: thread))
  }

  @Test func waitsForARootNotInYetWithoutShowingAide() throws {
    let model = model()
    let (project, thread) = try projectWithThread(in: model)
    let projects = model.projects
    model.projects.removeAll { $0.contains(project) }
    model.isLoading = true
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: thread)
    #expect(!router.applyRestore(in: model))
    #expect(router.landing(in: model) == nil)
    #expect(router.pendingRestore != nil)

    model.projects = projects
    model.isLoading = false
    #expect(router.applyRestore(in: model))
    #expect(router.landing(in: model) == .project(project))
  }

  @Test func restoresAtOnceWhileAnotherMachineIsStillLoading() throws {
    let model = model()
    let (project, thread) = try projectWithThread(in: model)
    let other = try #require(model.machines.first { $0.id != project.environmentId }).id
    model.isLoading = true
    model.unloadedShells = [other]
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: thread)
    #expect(router.landing(in: model) == .project(project))
    #expect(router.applyRestore(in: model))
    #expect(router.landing(in: model) == .project(project))
    #expect(router.main.path == [.chat(.thread(thread))])
  }

  @Test func threadOverTheDefaultLandingIsSavedAndRestoredOverAide() throws {
    let model = model()
    let store = store()
    let aide = try #require(model.aide).ref
    let thread = try #require(model.recentThreads.first).ref
    let router = AppRouter(lastOpenedStore: store, model: model)
    #expect(router.root == nil)
    router.pushThread(thread, on: router.main, in: model)
    #expect(store.load() == LastOpened(root: .aide(aide), thread: thread))

    let next = AppRouter(lastOpenedStore: store, model: model)
    next.pendingRestore = store.load()
    #expect(next.applyRestore(in: model))
    #expect(next.root == .aide(aide))
    #expect(next.main.path == [.chat(.thread(thread))])
    #expect(store.load() == LastOpened(root: .aide(aide), thread: thread))
  }

  @Test func deepLinkOverTheDefaultLandingKeepsTheThread() throws {
    let model = model()
    let store = store()
    let aide = try #require(model.aide).ref
    let router = AppRouter(lastOpenedStore: store, model: model)
    let linked = ThreadRef(environmentId: "env-studio-mac", threadId: "t-release")
    router.handle(.thread(linked))
    #expect(store.load() == LastOpened(root: .aide(aide), thread: linked))
  }

  @Test func projectAndThreadOnDifferentMachines() throws {
    let model = model()
    let store = store()
    let (project, _) = try projectWithThread(in: model)
    let thread = try #require(model.recentThreads.first { $0.ref.environmentId != project.environmentId }).ref
    store.save(LastOpened(root: .project(project), thread: thread))
    let router = AppRouter(lastOpenedStore: store)
    router.pendingRestore = store.load()
    #expect(router.applyRestore(in: model))
    #expect(router.root == .project(project))
    #expect(router.main.path == [.chat(.thread(thread))])
    #expect(store.load() == LastOpened(root: .project(project), thread: thread))
  }

  @Test func threadOnAMachineStillLoadingIsKeptUntilItLoads() throws {
    let model = model()
    let store = store()
    let (project, _) = try projectWithThread(in: model)
    let thread = try #require(model.recentThreads.first { $0.ref.environmentId != project.environmentId }).ref
    let lists = (model.threadsByProject, model.recentThreads)
    model.threadsByProject = model.threadsByProject.mapValues { $0.filter { $0.ref != thread } }
    model.recentThreads.removeAll { $0.ref == thread }
    model.unloadedShells = [thread.environmentId]
    model.isLoading = true
    let saved = LastOpened(root: .project(project), thread: thread)
    store.save(saved)
    let router = AppRouter(lastOpenedStore: store)
    router.pendingRestore = store.load()

    #expect(!router.applyRestore(in: model))
    #expect(router.root == .project(project))
    #expect(router.main.path.isEmpty)
    #expect(store.load() == saved)

    (model.threadsByProject, model.recentThreads) = lists
    model.unloadedShells = []
    #expect(router.applyRestore(in: model))
    #expect(router.main.path == [.chat(.thread(thread))])
    #expect(store.load() == saved)
  }

  @Test func loadingEndingOpensAThreadItsMachineNeverListed() throws {
    let model = model()
    let (project, _) = try projectWithThread(in: model)
    let other = try #require(model.machines.first { $0.id != project.environmentId }).id
    let thread = ThreadRef(environmentId: other, threadId: "t-unlisted")
    model.unloadedShells = [other]
    model.isLoading = true
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: thread)
    #expect(!router.applyRestore(in: model))
    model.isLoading = false
    #expect(router.applyRestore(in: model))
    #expect(router.main.path == [.chat(.thread(thread))])
  }

  @Test func deletedThreadRootFallsBackToAideAndClears() throws {
    let model = model()
    let store = store()
    store.save(LastOpened(root: .thread(ThreadRef(environmentId: "env-studio-mac", threadId: "gone")), thread: nil))
    let router = AppRouter(lastOpenedStore: store)
    router.pendingRestore = store.load()
    #expect(router.applyRestore(in: model))
    #expect(router.root == nil)
    #expect(router.landing(in: model) == .aide(try #require(model.aide).ref))
    #expect(store.load() == nil)
  }

  @Test func missingProjectFallsBackToAideAndClearsStore() throws {
    let model = model()
    let store = store()
    let gone = LastOpened(root: .project(ProjectRef(environmentId: "env-studio-mac", projectId: "gone")), thread: nil)
    store.save(gone)
    let router = AppRouter(lastOpenedStore: store)
    router.pendingRestore = store.load()
    #expect(router.applyRestore(in: model))
    #expect(router.root == nil)
    #expect(router.landing(in: model) == .aide(try #require(model.aide).ref))
    #expect(store.load() == nil)
  }

  @Test func missingThreadRestoresProjectOnly() throws {
    let model = model()
    let (project, _) = try projectWithThread(in: model)
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: ThreadRef(environmentId: project.environmentId, threadId: "gone"))
    #expect(router.applyRestore(in: model))
    #expect(router.root == .project(project))
    #expect(router.main.path.isEmpty)
  }

  @Test func deepLinkIsNotOverridden() throws {
    let model = model()
    model.isLoading = true
    let (project, thread) = try projectWithThread(in: model)
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: thread)
    let linked = ThreadRef(environmentId: "env-studio-mac", threadId: "t-release")
    router.handle(.thread(linked))
    #expect(router.pendingRestore == nil)
    model.isLoading = false
    #expect(router.applyRestore(in: model))
    #expect(router.main.path == [.chat(.thread(linked))])
    #expect(router.root == nil)
  }

  @Test func launchRouteCancelsRestore() throws {
    let model = model()
    let (project, thread) = try projectWithThread(in: model)
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: thread)
    router.pendingLaunchRoute = .overview
    #expect(router.applyLaunchRoute(in: model))
    #expect(router.applyRestore(in: model))
    #expect(router.pendingRestore == nil)
    #expect(router.root == nil)
    #expect(router.main.path == [.overview(try #require(model.projects.first).ref)])
  }

  @Test func navigatingBeforeLoadCancelsRestore() throws {
    let model = model()
    model.isLoading = true
    let (project, thread) = try projectWithThread(in: model)
    let router = AppRouter(lastOpenedStore: store())
    router.pendingRestore = LastOpened(root: .project(project), thread: thread)
    let aide = try #require(model.aide)
    router.open(.aide(aide.ref))
    #expect(router.pendingRestore == nil)
    model.isLoading = false
    router.applyRestore(in: model)
    #expect(router.root == .aide(aide.ref))
  }

  @Test func closingTheRootClearsTheStore() throws {
    let model = model()
    let store = store()
    let router = AppRouter(lastOpenedStore: store)
    let (project, _) = try projectWithThread(in: model)
    router.open(.project(project))
    router.root = nil
    #expect(store.load() == nil)
  }

  @Test func routerWithoutStoreNeverWrites() throws {
    let model = model()
    let before = UserDefaults.standard.data(forKey: LastOpenedStore.key)
    let router = AppRouter()
    let (project, thread) = try projectWithThread(in: model)
    router.open(.project(project))
    router.pushThread(thread, on: router.main, in: model)
    #expect(UserDefaults.standard.data(forKey: LastOpenedStore.key) == before)
  }

  @Test func codableRoundTrip() throws {
    let values = [
      LastOpened(root: .aide(ProjectRef(environmentId: "e", projectId: "aide")), thread: nil),
      LastOpened(root: .project(ProjectRef(environmentId: "e", projectId: "p")), thread: ThreadRef(environmentId: "e", threadId: "t")),
      LastOpened(root: .thread(ThreadRef(environmentId: "e", threadId: "t")), thread: nil),
    ]
    for value in values {
      let data = try JSONEncoder().encode(value)
      #expect(try JSONDecoder().decode(LastOpened.self, from: data) == value)
    }
    let store = store()
    store.defaults.set(Data("not json".utf8), forKey: LastOpenedStore.key)
    #expect(store.load() == nil)
  }
}
