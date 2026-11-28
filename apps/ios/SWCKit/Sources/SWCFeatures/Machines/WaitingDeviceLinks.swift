import SwiftUI
import SWCSync

/// Keep the refresh deadline across navigation and foreground transitions.
struct WaitingDeviceLinks: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(\.scenePhase) private var phase
  @State private var nextCheck: [String: ContinuousClock.Instant] = [:]
  @State private var waiting: Set<String> = []

  private var eligible: [String] {
    guard phase == .active, router.main.path.isEmpty, router.sheet == nil else { return [] }
    return model.machines.filter { $0.status.isOnline && $0.deviceApprovalCode == nil }.map(\.id)
  }

  var body: some View {
    let ids = eligible
    VStack {
      ForEach(ids.filter(waiting.contains), id: \.self) { id in
        if let machine = model.machine(id) {
          Button("Allow a waiting device on \(machine.displayName)") { router.push(.allowDevice(id)) }
            .font(.callout)
        }
      }
    }
    .task(id: ids) {
      guard !ids.isEmpty else { return }
      while !Task.isCancelled {
        for id in ids {
          guard !Task.isCancelled else { return }
          if let deadline = nextCheck[id], deadline > .now { continue }
          nextCheck[id] = .now + .seconds(60)
          let listing = await model.engine.allowDeviceListing(machineId: id)
          guard !Task.isCancelled else { return }
          if case let .ready(devices) = listing, !devices.isEmpty { waiting.insert(id) }
          else { waiting.remove(id) }
        }
        if let next = ids.compactMap({ nextCheck[$0] }).min() {
          try? await ContinuousClock().sleep(until: next)
        }
      }
    }
  }
}
