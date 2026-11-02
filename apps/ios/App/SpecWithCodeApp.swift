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
    // Only tests that pair with a disposable server leave Connect out.
    AppBootstrap.liveEngineFactory = {
      let account = ProcessInfo.processInfo.arguments.contains("-SWCDirectOnly") ? nil : ClerkConnectAccount(config: ConnectConfig.main())
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
