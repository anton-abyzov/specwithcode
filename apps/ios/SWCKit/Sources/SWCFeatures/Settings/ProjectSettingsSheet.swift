import SwiftUI
import SWCSync
import Weave

/// Name, goal, instructions and pause for a project or Aide.
struct ProjectSettingsSheet: View {
  let project: ProjectRef

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(\.dismiss) private var dismiss

  private enum Phase: Equatable {
    case loading
    case loaded
    case failed(String)
  }

  @State private var phase = Phase.loading
  @State private var original: ProjectSettingsDraft?
  @State private var draft = ProjectSettingsDraft(title: "", goal: "", instructions: "", paused: false, archived: false, coordinatorModel: nil, revision: 0)
  @State private var saving = false
  @State private var saveError: String?
  @State private var confirmArchive = false
  @State private var confirmDiscard = false

  private var summary: ProjectSummary? { model.project(project) }
  private var isDirty: Bool { original != nil && draft != original }
  private var canSave: Bool { isDirty && !saving && !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  var body: some View {
    content
      .screenChrome {
        ScreenHeader {
          // Asks before throwing away edits; can't close mid-save.
          WeaveIconButton("xmark", label: "Close") {
            if isDirty { confirmDiscard = true } else { dismiss() }
          }
          .disabled(saving)
        } center: {
          HeaderTitle(title: "Settings")
        } trailing: {
          if saving {
            ProgressView()
              .frame(width: WeaveSize.control, height: WeaveSize.control)
              .accessibilityLabel("Saving")
          } else {
            WeaveIconButton("checkmark", label: "Save", style: .filled) { save(draft) }
              .disabled(!canSave)
          }
        }
      }
      .interactiveDismissDisabled(isDirty)
      .onSheetDismissAttempt { if isDirty, !saving { confirmDiscard = true } }
      .task { await load() }
      .confirmationDialog("Archive \(draft.title.isEmpty ? "this project" : draft.title)?", isPresented: $confirmArchive, titleVisibility: .visible) {
        Button("Archive project", role: .destructive) { archive() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("It leaves the drawer and its coordinator stops. You can restore it in SpecWithCode on \(summary?.machineLabel ?? "your computer").")
      }
      .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
        Button("Discard changes", role: .destructive) { dismiss() }
        Button("Keep editing", role: .cancel) {}
      } message: {
        Text("Your edits to this project's settings haven't been saved.")
      }
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .loading:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Loading settings")
    case let .failed(message):
      ScrollView {
        EmptyState(systemName: "exclamationmark.triangle", title: "Couldn't load settings", message: message, actionTitle: "Try again") {
          Task { await load() }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, WeaveSpacing.s8)
      }
    case .loaded:
      form
    }
  }

  private var form: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        if let saveError {
          Banner(saveError, kind: .fail, onDismiss: { self.saveError = nil })
        }
        WeaveTextField("Project name", text: $draft.title, label: "Name") {
          ProjectAvatar(icon: summary?.icon.avatarIcon ?? .none, title: draft.title, size: 31)
        }
        WeaveTextEditor("What should this project achieve?", text: $draft.goal, label: "Goal", minLines: 3, maxLines: 10)
        WeaveTextEditor("Anything the coordinator should always keep in mind", text: $draft.instructions, label: "Instructions (optional)", minLines: 2, maxLines: 10)
        GroupedCard(footer: "Change the model in SpecWithCode on your computer.") {
          WeaveRow("Coordinator model", symbol: "cpu", trailingText: draft.coordinatorModel ?? "Default")
          WeaveToggleRow("Paused", subtitle: "The coordinator starts no new work", symbol: "pause.circle", isOn: $draft.paused)
        }
        if summary?.kind != .personal {
          GroupedCard {
            WeaveRow("Archive", symbol: "archivebox", isDestructive: true) { confirmArchive = true }
          }
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .scrollDismissesKeyboard(.interactively)
  }

  private func load() async {
    phase = .loading
    do {
      let loaded = try await model.engine.loadProjectSettings(project)
      original = loaded
      draft = loaded
      phase = .loaded
    } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  private func save(_ settings: ProjectSettingsDraft, closingProject: Bool = false) {
    saving = true
    saveError = nil
    Task {
      do {
        try await model.engine.saveProjectSettings(settings, for: project)
        if closingProject, router.root?.projectRef == project { router.root = nil }
        dismiss()
      } catch {
        saveError = error.localizedDescription
      }
      saving = false
    }
  }

  private func archive() {
    var settings = draft
    settings.archived = true
    save(settings, closingProject: true)
  }
}
