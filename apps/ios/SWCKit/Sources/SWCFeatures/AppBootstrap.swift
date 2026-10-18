import Foundation
import SWCSync

/// Builds the app model and routes incoming links.
///
/// Launch arguments: `-SWCFixture [default|empty|running]` serves sample data,
/// `-SWCAppearance light|dark` forces an appearance, and
/// `-SWCRoute overview|settings|projectSettings|machines|pair|thread|drawer|search`
/// opens a screen once data is in, for screenshots.
public enum AppBootstrap {
  /// Makes the engine for real machines. Set by the app target.
  public static var liveEngineFactory: (@MainActor () -> any AppEngine)?

  // Holds the model too, so its identifier is never reused by another model.
  private static var routers: [ObjectIdentifier: (model: AppModel, router: AppRouter)] = [:]

  public static func makeModel() -> AppModel {
    makeModel(arguments: ProcessInfo.processInfo.arguments)
  }

  static func makeModel(arguments: [String]) -> AppModel {
    let options = LaunchOptions.parse(arguments)
    let engine: any AppEngine
    if let scenario = options.fixture {
      engine = FixtureEngine(scenario: scenario)
    } else if let liveEngineFactory {
      engine = liveEngineFactory()
    } else {
      engine = FixtureEngine(scenario: .empty)
    }
    let model = AppModel(engine: engine)
    let router = router(for: model)
    router.appearanceOverride = options.appearance
    router.pendingLaunchRoute = options.route
    return model
  }

  /// Sample data for someone who has not paired a machine yet. It keeps the
  /// forced appearance of `model`, if any.
  static func makeSampleModel(beside model: AppModel) -> AppModel {
    let sample = AppModel(engine: FixtureEngine(scenario: .default))
    router(for: sample).appearanceOverride = router(for: model).appearanceOverride
    return sample
  }

  /// Forgets the navigation state of a model that is no longer shown.
  static func release(_ model: AppModel) {
    routers[ObjectIdentifier(model)] = nil
  }

  /// Handles `specwithcode://pair?link=<encoded link>` (opens pairing with the
  /// link filled in) and `specwithcode://thread/<environmentId>/<threadId>`.
  public static func handle(url: URL, model: AppModel) {
    guard let link = DeepLink(url: url) else { return }
    router(for: model).handle(link)
  }

  /// The navigation state that belongs to a model.
  static func router(for model: AppModel) -> AppRouter {
    let key = ObjectIdentifier(model)
    if let entry = routers[key] { return entry.router }
    let router = AppRouter()
    routers[key] = (model, router)
    return router
  }
}
