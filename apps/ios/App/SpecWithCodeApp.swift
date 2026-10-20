import SwiftUI
import SWCFeatures
import SWCSync
import SWCTransport

@main
struct SpecWithCodeApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var model: AppModel
  @Environment(\.scenePhase) private var scenePhase

  init() {
    // The device name is read at each pairing, so a rename needs no relaunch.
    // Without Connect settings in Info.plist the app pairs directly only.
    AppBootstrap.liveEngineFactory = {
      let account = ConnectConfig.main().map { ClerkConnectAccount(config: $0) }
      return LiveEngine(clientLabel: { DeviceLabel.current() }, account: account)
    }
    _model = State(initialValue: AppBootstrap.makeModel())
  }

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .onOpenURL { AppBootstrap.handle(url: $0, model: model) }
        .task(id: model.connect?.isSignedIn == true) {
          if model.connect?.isSignedIn == true { await PushRegistration.enable(engine: model.engine) }
        }
    }
    .onChange(of: scenePhase) { _, phase in
      if let active = EngineActivity.isActive(in: phase) {
        model.engine.setActive(active)
      }
    }
  }
}
