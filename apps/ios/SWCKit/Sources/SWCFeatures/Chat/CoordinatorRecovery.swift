import SwiftUI
import SWCSync
import SWCWire
import Weave

enum CoordinatorRecovery {
  static func asleep(_ name: String, lastSeen: Date?) -> String {
    var message = "\(name) is not answering. It may be asleep or its lid may be closed."
    if let lastSeen { message += " Last seen \(ThreadPlacement.seenTime(lastSeen, now: .now, calendar: .current, locale: .current))." }
    return message
  }

  static func limitMessage(_ message: String, limited: Bool, resetAt: String?, timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
    guard limited || message.contains("no remaining permitted usage") else { return nil }
    let marker = "Next observed reset: "
    let raw = message.range(of: marker).flatMap { message[$0.upperBound...].split(whereSeparator: \.isWhitespace).first }
    let date = resetAt.flatMap(WireCoding.parseDate) ?? raw.flatMap { WireCoding.parseDate(String($0).trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
    guard let date else { return "This model reached its usage limit." }
    let format = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: timeZone)
    return "This model reached its usage limit. It resets at \(date.formatted(format))."
  }
}

struct ChatErrorBanner: View {
  let message: String
  var limited = false
  var resetAt: String?
  var changeModel: (() -> Void)?
  var dismiss: (() -> Void)?

  var body: some View {
    if let limit = CoordinatorRecovery.limitMessage(message, limited: limited, resetAt: resetAt) {
      Banner(limit, kind: .fail, actionTitle: changeModel == nil ? nil : "Change model", action: changeModel, onDismiss: dismiss)
    } else {
      Banner(message, kind: .fail, onDismiss: dismiss)
    }
  }
}

extension AppRouter {
  func carryDraft(from source: ChatTarget, to destination: ChatTarget) {
    guard source != destination else { return }
    if let text = drafts.removeValue(forKey: source), !text.isEmpty {
      drafts[destination] = [drafts[destination] ?? "", text].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    if let photos = attachmentDrafts.removeValue(forKey: source) {
      attachmentDrafts[destination, default: []].append(contentsOf: photos)
    }
  }
}

/// The coordinator send reads the saved workspace model on each turn.
struct CoordinatorPicker: View {
  let project: ProjectRef
  @Binding var saving: Bool
  let session: ChatSession
  @Environment(AppModel.self) private var model
  @State private var settings: ProjectSettingsDraft?
  @State private var loadError: String?

  var body: some View {
    Group {
      if let settings, !settings.coordinatorChoices.isEmpty {
        ModelPickerSheet(models: settings.coordinatorChoices, selectedId: settings.selectedChoice?.id, machine: model.machine(project.environmentId)?.displayName) { choice in
          guard settings.selectedChoice?.id != choice.id else { return }
          var draft = settings
          draft.pickCoordinatorModel(choice)
          saving = true
          Task {
            defer { saving = false }
            do {
              try await model.engine.saveProjectSettings(draft, for: project)
              session.coordinatorModel = choice.name
            } catch { session.lastError = error.localizedDescription }
          }
        }
      } else if let loadError {
        Banner(loadError, kind: .fail, actionTitle: "Try again", action: { Task { await load() } })
      } else if settings != nil {
        Text("This machine has no available models.")
      } else {
        ProgressView("Loading models")
      }
    }
    .task { await load() }
  }

  private func load() async {
    loadError = nil
    do { settings = try await model.engine.loadProjectSettings(project) }
    catch { loadError = error.localizedDescription }
  }
}
