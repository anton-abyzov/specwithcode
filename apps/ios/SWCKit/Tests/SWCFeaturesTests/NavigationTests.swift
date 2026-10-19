import Foundation
import Testing
@testable import SWCFeatures
import SWCSync

@Suite("Launch options")
struct LaunchOptionsTests {
  @Test func noArgumentsMeansLive() {
    #expect(LaunchOptions.parse(["SpecWithCode"]) == LaunchOptions())
  }

  @Test func fixtureWithoutScenarioIsDefault() {
    #expect(LaunchOptions.parse(["app", "-SWCFixture"]).fixture == .default)
    #expect(LaunchOptions.parse(["app", "-SWCFixture", "-SWCAppearance", "dark"]).fixture == .default)
    #expect(LaunchOptions.parse(["app", "-SWCFixture", "YES"]).fixture == .default)
  }

  @Test func fixtureScenarioAppearanceAndRoute() {
    let options = LaunchOptions.parse(["app", "-SWCFixture", "running", "-SWCAppearance", "Dark", "-SWCRoute", "projectsettings"])
    #expect(options.fixture == .running)
    #expect(options.appearance == .dark)
    #expect(options.route == .projectSettings)
  }

  @Test func drawerRoutes() {
    #expect(LaunchOptions.parse(["app", "-SWCRoute", "drawer"]).route == .drawer)
    #expect(LaunchOptions.parse(["app", "-SWCRoute", "Search"]).route == .search)
  }

  @Test func unknownValuesAreIgnored() {
    let options = LaunchOptions.parse(["app", "-SWCAppearance", "sepia", "-SWCRoute", "nowhere"])
    #expect(options.appearance == nil)
    #expect(options.route == nil)
    #expect(LaunchOptions.parse(["app", "-SWCRoute"]).route == nil)
  }
}

@Suite("Deep links")
struct DeepLinkTests {
  @Test func pairLinkIsDecoded() throws {
    let inner = "https://studio-mac.local:3773/pair#token=ABC123"
    let encoded = try #require(inner.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
    let url = try #require(URL(string: "specwithcode://pair?link=\(encoded)"))
    #expect(DeepLink(url: url) == .pair(link: inner))
  }

  @Test func pairWithoutLinkStillOpensPairing() throws {
    #expect(DeepLink(url: try #require(URL(string: "specwithcode://pair"))) == .pair(link: nil))
    #expect(DeepLink(url: try #require(URL(string: "specwithcode://pair?link="))) == .pair(link: nil))
    #expect(DeepLink(url: try #require(URL(string: "specwithcode://pair?pairingUrl=https%3A%2F%2Fm4.ts.net%2Fpair%23token%3Dx"))) == .pair(link: "https://m4.ts.net/pair#token=x"))
  }

  @Test func threadLink() throws {
    let url = try #require(URL(string: "specwithcode://thread/env-studio-mac/t-release"))
    #expect(DeepLink(url: url) == .thread(ThreadRef(environmentId: "env-studio-mac", threadId: "t-release")))
  }

  @Test func threadLinkWithEncodedParts() throws {
    let url = try #require(URL(string: "specwithcode://thread/env%3A1/thread%20one"))
    #expect(DeepLink(url: url) == .thread(ThreadRef(environmentId: "env:1", threadId: "thread one")))
  }

  @Test func rejectsOtherLinks() throws {
    for text in ["https://example.com/pair?link=x", "specwithcode://thread/only-env", "specwithcode://thread/a/b/c", "specwithcode://settings"] {
      #expect(DeepLink(url: try #require(URL(string: text))) == nil, "\(text)")
    }
  }
}

@Suite("Formatting and grouping")
struct LogicTests {
  let now = Date(timeIntervalSince1970: 1_800_000_000)

  @Test func elapsedLabels() {
    #expect(Elapsed.short(since: now.addingTimeInterval(-20), now: now) == "<1m")
    #expect(Elapsed.short(since: now.addingTimeInterval(-120), now: now) == "2m")
    #expect(Elapsed.short(since: now.addingTimeInterval(-7_300), now: now) == "2h")
    #expect(Elapsed.short(since: now.addingTimeInterval(-3 * 86_400), now: now) == "3d")
    #expect(Elapsed.short(since: now.addingTimeInterval(-15 * 86_400), now: now) == "2w")
    #expect(Elapsed.short(since: now.addingTimeInterval(60), now: now) == "<1m")
    #expect(Elapsed.spoken(since: now.addingTimeInterval(-60), now: now) == "1 minute")
    #expect(Elapsed.spoken(since: now.addingTimeInterval(-7_300), now: now) == "2 hours")
  }

  private func thread(_ id: String, _ activity: ThreadActivity, minutesAgo: Double, pinned: Bool = false, resolved: Bool = false, title: String? = nil, preview: String? = nil) -> ThreadSummary {
    ThreadSummary(
      ref: ThreadRef(environmentId: "env", threadId: id),
      projectTitle: "SpecWeave",
      title: title ?? id,
      activity: activity,
      preview: preview,
      updatedAt: now.addingTimeInterval(-minutesAgo * 60),
      isPinned: pinned,
      isResolved: resolved,
      machineLabel: "Office Mac",
      machineOnline: true
    )
  }

  @Test func groupsByWhatTheyNeed() {
    let groups = ThreadGroups([
      thread("idle-old", .idle, minutesAgo: 90),
      thread("failed", .failed, minutesAgo: 30),
      thread("working", .working, minutesAgo: 2),
      thread("needs", .needsYou, minutesAgo: 1),
      thread("idle-pinned", .idle, minutesAgo: 500, pinned: true),
      thread("idle-new", .idle, minutesAgo: 5),
      thread("done", .working, minutesAgo: 3, resolved: true),
    ])
    #expect(groups.needsYou.map(\.ref.threadId) == ["needs", "failed"])
    #expect(groups.working.map(\.ref.threadId) == ["working"])
    #expect(groups.idle.map(\.ref.threadId) == ["idle-pinned", "idle-new", "idle-old"])
    #expect(groups.resolved.map(\.ref.threadId) == ["done"])
    #expect(!groups.isEmpty)
    #expect(ThreadGroups([]).isEmpty)
  }

  @Test func groupsFilterByQuery() {
    let threads = [
      thread("a", .idle, minutesAgo: 1, title: "Release checklist"),
      thread("b", .working, minutesAgo: 1, title: "Docs", preview: "Waiting for the release tag"),
      thread("c", .idle, minutesAgo: 1, title: "Other"),
    ]
    let groups = ThreadGroups(threads, query: "  release ")
    #expect(groups.idle.map(\.ref.threadId) == ["a"])
    #expect(groups.working.map(\.ref.threadId) == ["b"])
  }

  @Test func searchMatchesProjectsAndThreads() {
    let projects = [
      ProjectSummary(ref: ProjectRef(environmentId: "env", projectId: "p1"), title: "Recipe app", machineLabel: "Build box", machineOnline: true),
      ProjectSummary(ref: ProjectRef(environmentId: "env", projectId: "p2"), title: "Old recipes", machineLabel: "Build box", machineOnline: true, archived: true),
      ProjectSummary(ref: ProjectRef(environmentId: "env", projectId: "p3"), title: "SpecWeave", machineLabel: "Office Mac", machineOnline: true),
    ]
    let threads = [thread("t1", .idle, minutesAgo: 1, title: "Shrink the recipe image cache"), thread("t2", .idle, minutesAgo: 1, title: "Other")]
    let results = SearchResults(query: "RECIPE", projects: projects, threads: threads)
    #expect(results.projects.map(\.title) == ["Recipe app"])
    #expect(results.threads.map(\.ref.threadId) == ["t1"])
    #expect(SearchResults(query: " ", projects: projects, threads: threads).isEmpty)
    #expect(SearchResults(query: "zzz", projects: projects, threads: threads).isEmpty)
  }
}

@MainActor
@Suite("Router")
struct RouterTests {
  private func model(_ scenario: FixtureScenario = .default) -> AppModel {
    let engine = FixtureEngine(scenario: scenario)
    engine.latency = .zero
    engine.streamDelay = .zero
    return AppModel(engine: engine)
  }

  @Test func landingPrefersAide() throws {
    let model = model()
    let router = AppRouter()
    let aide = try #require(model.aide)
    #expect(router.landing(in: model) == .aide(aide.ref))
    model.aide = nil
    #expect(router.landing(in: model) == .project(try #require(model.projects.first).ref))
    model.projects = []
    #expect(router.landing(in: model) == nil)
  }

  @Test func landingFallsBackWhenRootIsGone() throws {
    let model = model()
    let router = AppRouter()
    let project = try #require(model.projects.last)
    router.open(.project(project.ref))
    #expect(router.landing(in: model) == .project(project.ref))
    model.projects.removeAll { $0.ref == project.ref }
    #expect(router.landing(in: model) == .aide(try #require(model.aide).ref))
  }

  @Test func openClearsPathAndClosesDrawer() {
    let router = AppRouter()
    router.isDrawerOpen = true
    router.push(.machines)
    #expect(router.main.path == [.machines])
    #expect(!router.isDrawerOpen)
    router.isDrawerOpen = true
    router.open(.thread(ThreadRef(environmentId: "e", threadId: "t")))
    #expect(router.main.path.isEmpty)
    #expect(!router.isDrawerOpen)
  }

  @Test func deepLinksNavigate() {
    let router = AppRouter()
    router.sheet = .globalSettings
    router.handle(.pair(link: "https://m.local/pair#token=x"))
    #expect(router.sheet == nil)
    #expect(router.main.path == [.pair])
    #expect(router.pairPrefill == "https://m.local/pair#token=x")
    let ref = ThreadRef(environmentId: "env", threadId: "t")
    router.handle(.thread(ref))
    #expect(router.main.path == [.chat(.thread(ref))])
  }

  @Test func launchRoutes() throws {
    let model = model()
    let router = AppRouter()
    router.pendingLaunchRoute = .thread
    #expect(router.applyLaunchRoute(in: model))
    #expect(router.main.path == [.chat(.thread(ThreadRef(environmentId: "env-studio-mac", threadId: "t-release")))])
    #expect(router.pendingLaunchRoute == nil)

    router.pendingLaunchRoute = .overview
    router.applyLaunchRoute(in: model)
    #expect(router.main.path == [.overview(try #require(model.projects.first).ref)])

    router.pendingLaunchRoute = .projectSettings
    router.applyLaunchRoute(in: model)
    #expect(router.sheet == .projectSettings(try #require(model.projects.first).ref))

    router.pendingLaunchRoute = .settings
    router.applyLaunchRoute(in: model)
    #expect(router.sheet == .globalSettings)
  }

  @Test func drawerLaunchRoutes() {
    let model = model()
    let router = AppRouter()
    router.pendingLaunchRoute = .drawer
    #expect(router.applyLaunchRoute(in: model))
    #expect(router.isDrawerOpen)
    #expect(!router.isDrawerSearching)
    #expect(router.main.path.isEmpty)

    router.isDrawerOpen = false
    router.pendingLaunchRoute = .search
    #expect(router.applyLaunchRoute(in: model))
    #expect(router.isDrawerOpen)
    #expect(router.isDrawerSearching)
  }

  @Test func drawerRouteWaitsForDataAndNeedsMachines() {
    let loading = model()
    loading.isLoading = true
    let router = AppRouter()
    router.pendingLaunchRoute = .drawer
    #expect(!router.applyLaunchRoute(in: loading))
    #expect(!router.isDrawerOpen)

    let empty = model(.empty)
    let other = AppRouter()
    other.pendingLaunchRoute = .search
    #expect(other.applyLaunchRoute(in: empty))
    #expect(!other.isDrawerOpen)
    #expect(other.pendingLaunchRoute == nil)
  }

  @Test func closingTheDrawerEndsSearch() {
    let router = AppRouter()
    router.isDrawerOpen = true
    router.isDrawerSearching = true
    router.open(.thread(ThreadRef(environmentId: "e", threadId: "t")))
    #expect(!router.isDrawerOpen)
    #expect(!router.isDrawerSearching)
  }

  @Test func drawerShowsMachineOnlyForSharedTitles() {
    let projects = [
      ProjectSummary(ref: ProjectRef(environmentId: "a", projectId: "1"), title: "Docs", machineLabel: "Office Mac", machineOnline: true),
      ProjectSummary(ref: ProjectRef(environmentId: "b", projectId: "2"), title: "docs", machineLabel: "Build box", machineOnline: true),
      ProjectSummary(ref: ProjectRef(environmentId: "a", projectId: "3"), title: "Recipe app", machineLabel: "Office Mac", machineOnline: true),
    ]
    #expect(DrawerView.sharedTitles(projects) == ["docs"])
    #expect(DrawerView.sharedTitles([]).isEmpty)
  }

  @Test func launchRouteWaitsForData() {
    let model = model()
    model.isLoading = true
    let router = AppRouter()
    router.pendingLaunchRoute = .overview
    #expect(!router.applyLaunchRoute(in: model))
    #expect(router.pendingLaunchRoute == .overview)
    model.isLoading = false
    #expect(router.applyLaunchRoute(in: model))
    #expect(router.pendingLaunchRoute == nil)
  }

  @Test func routeRoundTripsThroughCodable() throws {
    let routes: [Route] = [
      .chat(.aide(ProjectRef(environmentId: "e", projectId: "aide"))),
      .chat(.thread(ThreadRef(environmentId: "e", threadId: "t"))),
      .overview(ProjectRef(environmentId: "e", projectId: "p")),
      .machines, .machine("e"), .pair, .repair("e"),
    ]
    let data = try JSONEncoder().encode(routes)
    #expect(try JSONDecoder().decode([Route].self, from: data) == routes)
  }
}

@MainActor
@Suite("Bootstrap")
struct BootstrapTests {
  @Test func sampleDataRunsOnItsOwnModel() {
    let model = AppBootstrap.makeModel(arguments: ["app", "-SWCFixture", "empty", "-SWCAppearance", "dark"])
    let sample = AppBootstrap.makeSampleModel(beside: model)
    #expect(sample !== model)
    #expect(sample.engine is FixtureEngine)
    #expect(!sample.machines.isEmpty)
    #expect(model.machines.isEmpty)
    let router = AppBootstrap.router(for: sample)
    #expect(router.appearanceOverride == .dark)
    AppBootstrap.release(sample)
    #expect(AppBootstrap.router(for: sample) !== router)
    AppBootstrap.release(sample)
  }

  @Test func fixtureArgumentPicksScenario() throws {
    let model = AppBootstrap.makeModel(arguments: ["app", "-SWCFixture", "empty"])
    #expect(model.engine is FixtureEngine)
    #expect(model.machines.isEmpty)
    #expect(!model.isLoading)
    let full = AppBootstrap.makeModel(arguments: ["app", "-SWCFixture", "-SWCAppearance", "dark", "-SWCRoute", "pair"])
    #expect(full.machines.count == 3)
    let router = AppBootstrap.router(for: full)
    #expect(router.appearanceOverride == .dark)
    #expect(router.pendingLaunchRoute == .pair)
    #expect(AppBootstrap.router(for: full) === router)
  }

  @Test func liveFactoryIsUsedWithoutFixtureArgument() {
    var made = false
    AppBootstrap.liveEngineFactory = {
      made = true
      return FixtureEngine(scenario: .running)
    }
    defer { AppBootstrap.liveEngineFactory = nil }
    let model = AppBootstrap.makeModel(arguments: ["app"])
    #expect(made)
    #expect((model.engine as? FixtureEngine)?.scenario == .running)
    AppBootstrap.liveEngineFactory = nil
    let fallback = AppBootstrap.makeModel(arguments: ["app"])
    #expect((fallback.engine as? FixtureEngine)?.scenario == .empty)
  }

  @Test func handleOpensPairing() throws {
    let model = AppBootstrap.makeModel(arguments: ["app", "-SWCFixture", "empty"])
    AppBootstrap.handle(url: try #require(URL(string: "specwithcode://pair?link=https%3A%2F%2Fbox.local%2Fpair%23token%3Dabc")), model: model)
    let router = AppBootstrap.router(for: model)
    #expect(router.main.path == [.pair])
    #expect(router.pairPrefill == "https://box.local/pair#token=abc")
  }
}
