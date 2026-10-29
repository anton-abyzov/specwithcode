import SwiftUI
import SWCSync
import Weave

/// The whole app, on the model it was given or, until the person leaves it,
/// on sample data they chose to explore before pairing a machine.
public struct RootView: View {
  let model: AppModel
  @State private var sample: AppModel?

  public init(model: AppModel) {
    self.model = model
  }

  public var body: some View {
    if let sample {
      AppScreens(model: sample)
        .environment(\.sampleData, SampleDataMode(isActive: true, exit: { leaveSample() }))
        .transition(.opacity)
    } else {
      AppScreens(model: model)
        .environment(\.sampleData, SampleDataMode(isActive: false, enter: { exploreSample() }))
        .transition(.opacity)
    }
  }

  private func exploreSample() {
    withAnimation(.easeInOut(duration: 0.25)) { sample = AppBootstrap.makeSampleModel(beside: model) }
  }

  private func leaveSample() {
    guard let current = sample else { return }
    withAnimation(.easeInOut(duration: 0.25)) {
      sample = nil
    } completion: {
      AppBootstrap.release(current)
    }
  }
}

/// Drawer, main navigation stack, sheets and toasts for one model.
private struct AppScreens: View {
  let model: AppModel
  @State private var router: AppRouter
  @State private var keyboardInset: CGFloat = 0
  @Environment(\.sampleData) private var sampleData

  init(model: AppModel) {
    self.model = model
    self._router = State(initialValue: AppBootstrap.router(for: model))
  }

  var body: some View {
    // The sample data bar sits above everything, drawer included, so the
    // screens below it start under it.
    VStack(spacing: 0) {
      if sampleData.isActive { SampleDataBar(onExit: sampleData.exit) }
      screens
    }
    .sheet(item: $router.sheet) { sheet in
      SheetHost(sheet: sheet)
        .environment(model)
        .environment(router)
        .environment(router.main)
    }
    // A sheet covers this overlay, so while one is up the sheet shows the toast.
    .weaveToast(Binding(get: { router.sheet == nil ? router.toast : nil }, set: { router.toast = $0 }))
    .environment(model)
    .environment(router)
    .environment(router.main)
    .weaveTheme(appearance: currentAppearance.rawValue)
    .task(id: launchKey) { router.applyLaunchRoute(in: model) }
  }

  /// The drawer and the main stack. The drawer clips the main screen to its
  /// own frame, so it fills the space and the stack is inset by the real safe
  /// area (keyboard included). The canvas behind the stack then reaches under
  /// the status bar and home indicator, and the stack's frame never overlaps
  /// an unsafe area.
  private var screens: some View {
    @Bindable var router = router
    @Bindable var main = router.main
    return GeometryReader { proxy in
      let insets = EdgeInsets(
        top: proxy.safeAreaInsets.top, leading: proxy.safeAreaInsets.leading,
        bottom: max(proxy.safeAreaInsets.bottom, keyboardInset), trailing: proxy.safeAreaInsets.trailing
      )
      DrawerContainer(isOpen: $router.isDrawerOpen, edgeSwipeEnabled: main.path.isEmpty && !model.machines.isEmpty, sceneInsets: insets) {
        DrawerView()
      } content: {
        NavigationStack(path: $main.path) {
          RootContent()
            .hiddenUnderDrawer()
            .navigationDestination(for: Route.self) { RouteDestination(route: $0).hiddenUnderDrawer() }
        }
        .background(Color.weave.canvas)
      }
      .background { KeyboardInsetReader { keyboardInset = $0 } }
      .ignoresSafeArea()
    }
  }

  private var currentAppearance: AppearancePreference { router.appearanceOverride ?? model.appearance }

  /// Changes when the data a launch route waits for arrives.
  private var launchKey: String { "\(model.isLoading)-\(model.machines.count)-\(model.projects.count)" }
}

/// The screen at the root of the main stack.
private struct RootContent: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    if model.machines.isEmpty {
      if model.isLoading { LoadingView() } else { PairWelcomeView() }
    } else if let target = router.landing(in: model) {
      ChatView(target: target)
    } else if model.isLoading {
      LoadingView()
    } else if !model.allMachinesLoaded {
      // An offline machine may hold Aide and the projects.
      OfflineMachinesView()
    } else {
      SetUpAideView()
    }
  }
}

struct RouteDestination: View {
  let route: Route

  var body: some View {
    switch route {
    case let .chat(target): ChatView(target: target, isPushed: true)
    case let .overview(project): ProjectOverviewView(project: project)
    case .machines: MachinesView()
    case let .machine(id): MachineDetailView(machineId: id)
    case .pair: PairMachineView()
    case let .repair(id): PairMachineView(expectedMachineId: id)
    }
  }
}

private struct SheetHost: View {
  let sheet: SheetRoute
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    let appearance = (router.appearanceOverride ?? model.appearance).rawValue
    Group {
      switch sheet {
      case .globalSettings:
        GlobalSettingsSheet().weaveSheetStyle(appearance: appearance)
      case let .projectSettings(project):
        ProjectSettingsSheet(project: project).weaveSheetStyle(appearance: appearance)
      case let .threadInfo(thread):
        ThreadInfoSheet(thread: thread).weaveSheetStyle(appearance: appearance, detents: [.medium, .large])
      }
    }
    .weaveToast(Binding(get: { router.toast }, set: { router.toast = $0 }))
  }
}

private struct LoadingView: View {
  @Environment(AppRouter.self) private var router
  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(spacing: WeaveSpacing.s3) {
      ProgressView()
      Text("Connecting to your machines")
        .weaveFont(.callout)
        .foregroundStyle(Color.weave.muted)
      if model.connect != nil {
        WeaveButton("SpecWithCode Connect", kind: .secondary) { router.sheet = .globalSettings }
      }
      WeaveButton("Machines", kind: .secondary) { router.push(.machines) }
      WeaveButton("Settings", kind: .ghost) { router.sheet = .globalSettings }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .screenBackground()
  }
}

/// Shown when machines are paired, none of them shows Aide or a project, and
/// at least one is offline, so they may be on that machine.
private struct OfflineMachinesView: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router

  var body: some View {
    ScrollView {
      VStack(spacing: WeaveSpacing.s2) {
        EmptyState(
          systemName: "wifi.slash",
          title: title,
          message: "Aide and your projects appear when \(offline.count == 1 ? "it reconnects" : "they reconnect").",
          actionTitle: model.connect != nil ? "SpecWithCode Connect" : offline.contains(where: \.canRetryConnection) ? "Reconnect" : nil,
          action: model.connect != nil ? { router.sheet = .globalSettings } : reconnect
        )
        if model.connect != nil, offline.contains(where: \.canRetryConnection) {
          WeaveButton("Reconnect", kind: .secondary, action: reconnect)
        }
        WeaveButton("Machines", kind: .ghost) { router.push(.machines) }
      }
      .padding(.top, WeaveSpacing.s8 * 2)
      .frame(maxWidth: .infinity)
    }
    .screenChrome {
      ScreenHeader {
        MenuButton()
      } center: {
        HeaderTitle(title: "SpecWithCode")
      } trailing: {
        EmptyView()
      }
    }
  }

  private var offline: [MachineSummary] { model.machines.filter { !$0.status.isOnline } }

  private var title: String {
    if offline.count == 1 {
      return offline[0].recoveryTitle
    }
    return offline.count == model.machines.count ? "Your machines are offline" : "Some machines are offline"
  }

  private func reconnect() {
    for machine in offline where !machine.isDisconnected { model.engine.reconnect(machineId: machine.id) }
  }
}

/// Shown when every paired machine is online and none has Aide or a project yet.
private struct SetUpAideView: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var working = false

  var body: some View {
    ScrollView {
      EmptyState(
        systemName: WeaveLucide.assistantSystemName,
        title: "Set up Aide",
        message: "Aide is your personal assistant. It answers questions and starts work in your projects on \(machineName).",
        actionTitle: working ? nil : "Set up Aide",
        action: working ? nil : { setUp() }
      )
      .padding(.top, WeaveSpacing.s8 * 2)
      .frame(maxWidth: .infinity)
      if working {
        ProgressView()
          .padding(.top, WeaveSpacing.s4)
          .accessibilityLabel("Setting up Aide")
      }
    }
    .screenChrome {
      ScreenHeader {
        MenuButton()
      } center: {
        HeaderTitle(title: "SpecWithCode")
      } trailing: {
        EmptyView()
      }
    }
  }

  /// Aide goes on the machine with the lowest environment id, the same one
  /// every client picks.
  private var machineName: String {
    model.machines.min { $0.id < $1.id }?.displayName ?? "your machine"
  }

  private func setUp() {
    working = true
    Task {
      do {
        let ref = try await model.engine.setupAide()
        router.open(.aide(ref))
      } catch {
        router.showError(error)
      }
      working = false
    }
  }
}
