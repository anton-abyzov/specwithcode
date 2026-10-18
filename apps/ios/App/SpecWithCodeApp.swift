import SwiftUI
import SWCFeatures
import SWCSync

@main
struct SpecWithCodeApp: App {
  @State private var model: AppModel
  @Environment(\.scenePhase) private var scenePhase

  init() {
    // The device name is read at each pairing, so a rename needs no relaunch.
    AppBootstrap.liveEngineFactory = { LiveEngine(clientLabel: { DeviceLabel.current() }) }
    _model = State(initialValue: AppBootstrap.makeModel())
  }

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .onOpenURL { AppBootstrap.handle(url: $0, model: model) }
    }
    .onChange(of: scenePhase) { _, phase in
      if let active = EngineActivity.isActive(in: phase) {
        model.engine.setActive(active)
      }
    }
  }
}
