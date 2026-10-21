import SwiftUI
import SWCSync
import Weave

/// Viewing a thread is separate from explicitly checking and continuing it.
struct HandoffSheet: View {
  let thread: ThreadRef
  let onContinue: (ThreadRef) -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var options: HandoffOptions?
  @State private var selection: HandoffDestination?
  @State private var check: HandoffCheck?
  @State private var error: String?
  @State private var busy = false

  var body: some View {
    NavigationStack {
      List {
        if let options {
          if let badge = options.badge { Text(Self.badgeTitle(badge)).font(.headline) }
          if options.destinations.isEmpty {
            Text("No reachable machine can continue this thread. Link the project and enable Handoff mode on a computer first. An offline source needs a checkpoint already saved on another machine.")
          }
          ForEach(options.destinations) { destination in
            Button("Check \(destination.name)") {
              selection = destination
              check = nil
              run { check = try await model.engine.checkHandoff(thread, destination: destination) }
            }
            .disabled(busy)
            .accessibilityIdentifier("handoff.check.\(destination.id)")
          }
          ForEach(options.notices, id: \.self) { Text($0) }
        } else if error == nil { ProgressView("Checking machines") }
        if let check, let selection {
          Section("Before continuing") {
            ForEach(check.messages, id: \.self) { Text($0) }
            if check.allowed {
              Button("Continue here on \(selection.name)") {
                run {
                  let next = try await model.engine.continueThread(thread, destination: selection)
                  dismiss()
                  onContinue(next)
                }
              }
              .disabled(busy)
              .accessibilityIdentifier("handoff.continue")
            }
          }
        }
        if let error {
          Section("Couldn't continue") {
            Text(error)
            Button("Refresh") { run { options = try await model.engine.handoffOptions(for: thread) } }
              .disabled(busy)
          }
        }
      }
      .navigationTitle("Continue on a machine")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) } }
      .interactiveDismissDisabled(busy)
      .task { run { options = try await model.engine.handoffOptions(for: thread) } }
    }
  }

  static func badgeTitle(_ badge: String) -> String {
    switch badge {
    case "ready": "Handoff ready"
    case "behind": "Checkpoint catching up"
    case "handing-off": "Handing off"
    case "continued": "Continued on another machine"
    case "source-unreachable": "Source unreachable"
    case "paused": "Handoff paused"
    default: "Handoff status unavailable"
    }
  }

  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    guard !busy else { return }
    busy = true; error = nil
    Task { @MainActor in
      defer { busy = false }
      do { try await action() } catch { self.error = error.localizedDescription }
    }
  }
}
