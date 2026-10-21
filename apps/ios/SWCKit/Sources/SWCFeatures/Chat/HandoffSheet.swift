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
  @State private var progress = "Checking machines"
  @State private var continued: ThreadRef?
  @State private var uncertain = false

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("Move this conversation and its checkpoint to another machine. The source becomes read-only. Opening these options does not move anything.")
            .font(.subheadline)
        }
        if let continued, let selection {
          Section("Handoff completed") {
            Label("Continued on \(selection.name)", systemImage: "checkmark.circle")
            Text(model.engine is FixtureEngine
              ? "Sample continuation created. No real machine or provider ran."
              : "The server returned the continuation. Open it to see its current activity and send your next message.")
            Button("Open thread on \(selection.name)") { dismiss(); onContinue(continued) }
              .accessibilityIdentifier("handoff.open")
          }
        } else if !uncertain, let options {
          if let badge = options.badge { Text(Self.badgeTitle(badge)).font(.headline) }
          if options.destinations.isEmpty {
            Text("No eligible destination is available.").font(.headline)
          }
          ForEach(options.destinations) { destination in
            Button("Check \(destination.name)") {
              selection = destination
              check = nil
              run("Checking \(destination.name)…") { check = try await model.engine.checkHandoff(thread, destination: destination) }
            }
            .disabled(busy || uncertain)
            .accessibilityIdentifier("handoff.check.\(destination.id)")
          }
          ForEach(options.notices, id: \.self) { Text($0) }
        } else if error == nil { ProgressView("Checking machines") }
        if !uncertain, continued == nil, let check, let selection {
          Section("Before continuing") {
            ForEach(check.messages, id: \.self) { Text($0) }
            if check.allowed {
              Button("Hand off to \(selection.name)") {
                run("Handing off to \(selection.name)…") {
                  continued = try await model.engine.continueThread(thread, destination: selection)
                }
              }
              .disabled(busy)
              .accessibilityIdentifier("handoff.continue")
            }
          }
        }
        if busy { ProgressView(progress).accessibilityIdentifier("handoff.progress") }
        if let error {
          Section(uncertain ? "Handoff in doubt" : "Couldn't continue") {
            if uncertain {
              Text("The transfer may have started. Do not retry it or start duplicate work. The source remains protected; opening a destination thread does not prove completion.")
            }
            Text(error)
            Button("Refresh status") {
              run {
                options = try await model.engine.handoffOptions(for: thread)
                check = nil
              }
            }
              .disabled(busy)
          }
        }
      }
      .navigationTitle("Hand off thread")
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

  private func run(_ message: String = "Checking machines", _ action: @escaping @MainActor () async throws -> Void) {
    guard !busy else { return }
    busy = true; if !uncertain { error = nil }; progress = message
    Task { @MainActor in
      defer { busy = false }
      do { try await action() } catch {
        if error is HandoffUncertain { uncertain = true; check = nil }
        self.error = error.localizedDescription
      }
    }
  }
}
