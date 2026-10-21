import SwiftUI
import SWCSync
import Weave

struct IncrementSheet: View {
  let target: ChatTarget
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var result: IncrementRead?
  @State private var error: String?
  @State private var loading = false

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("SpecWeave reads the project's spec and task ledger on \(model.machine(target.environmentId)?.displayName ?? "this machine"). Provider checklists and proposed plans are separate conversation content.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
        if loading { ProgressView("Reading increment…") }
        if let error {
          Section("Couldn't read increment") { Text(error).textSelection(.enabled) }
        }
        if let result {
          switch result {
          case .unbound:
            Section("No linked increment") {
              Text("The server found no SpecWeave increment bound to this thread. A provider checklist does not create that binding. Link the thread in the desktop app or have the agent record work with SpecWeave.")
            }
          case let .unavailable(reason): Section("Increment unavailable") { Text(reason) }
          case let .bound(progress): increment(progress)
          }
        }
      }
      .navigationTitle("SpecWeave increment")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .primaryAction) { Button("Refresh") { Task { await refresh() } }.disabled(loading) }
      }
      .task { await refresh() }
    }
  }

  @ViewBuilder private func increment(_ p: IncrementProgress) -> some View {
    Section(p.incrementId) {
      if let title = p.title { Text(title).font(.headline) }
      LabeledContent("Status", value: p.status)
      LabeledContent("Binding", value: p.binding)
      if let task = p.boundTaskId { LabeledContent("This thread's task", value: task) }
      if !p.readable {
        Text("The increment is linked, but its tasks or ledger could not be read. Empty rows do not mean the work is complete.").foregroundStyle(.orange)
      }
    }
    Section("Tasks · \(p.tasks.filter { $0.status == "done" || $0.status == "skipped" }.count)/\(p.tasks.count) settled") {
      ForEach(p.tasks) { task in
        VStack(alignment: .leading, spacing: 6) {
          Text("\(task.id) · \(task.status)").font(.caption).foregroundStyle(.secondary)
          Text(task.line ?? task.title)
          if let note = task.note { Text(note).font(.subheadline) }
          if !task.criteria.isEmpty { Text(task.criteria.joined(separator: ", ")).font(.caption) }
          if let raw = task.link, let url = URL(string: raw), url.scheme == "https", ["github.com", "claude.ai"].contains(url.host ?? "") { Link("Evidence", destination: url) }
          if let commit = task.commit { Text(commit).font(.caption.monospaced()).textSelection(.enabled) }
        }
      }
    }
    Section("Acceptance criteria") {
      ForEach(p.criteria) { criterion in
        VStack(alignment: .leading, spacing: 4) {
          Text("\(criterion.id) · \(criterion.met ? "Ledger satisfied" : "Pending")").font(.caption).foregroundStyle(.secondary)
          Text(criterion.text)
        }
      }
    }
    Section("Verification") {
      if let verify = p.verify {
        Text(verify.ok ? "Last verification passed" : "Last verification failed")
        Text(verify.ranAt).font(.caption).textSelection(.enabled)
      } else { Text("No verification result recorded.") }
      Text("Task and criterion states come from the ledger. They do not prove a release or a physical-device check.").font(.caption).foregroundStyle(.secondary)
    }
    Section("Source on \(model.machine(target.environmentId)?.displayName ?? "machine")") {
      Text(p.specPath ?? p.incrementPath).font(.caption.monospaced()).textSelection(.enabled)
      Text("Remote source path; open it on this machine in the desktop app.").font(.caption).foregroundStyle(.secondary)
    }
  }

  private func refresh() async {
    loading = true; error = nil; result = nil
    defer { loading = false }
    do { result = try await model.engine.incrementProgress(for: target) }
    catch { self.error = error.localizedDescription }
  }
}
