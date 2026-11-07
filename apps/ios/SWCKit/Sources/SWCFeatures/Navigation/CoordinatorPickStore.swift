import Foundation
import SWCSync

/// The machine whose coordinator this phone last viewed, per project on
/// several machines, as the desktop's `projectCoordinatorMachines` keeps it.
/// Viewing a copy never moves the coordinator; only a takeover does.
struct CoordinatorPickStore {
  static let key = "swc.coordinatorMachines"
  let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  /// The saved copy, while it is still one of the project's copies.
  func pick(for project: ProjectSummary) -> ProjectRef? {
    guard project.members.count > 1,
          let saved = picks()[Self.projectKey(project)],
          let ref = Self.ref(saved),
          project.members.contains(where: { $0.ref == ref }) else { return nil }
    return ref
  }

  func save(_ ref: ProjectRef, for project: ProjectSummary) {
    guard project.members.count > 1, project.contains(ref) else { return }
    var all = picks()
    all[Self.projectKey(project)] = "\(ref.environmentId)\n\(ref.projectId)"
    defaults.set(all, forKey: Self.key)
  }

  private func picks() -> [String: String] {
    defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:]
  }

  /// The linked project, else the shared folder, else the row's own copy, so
  /// the same project keeps its pick whichever copy leads the row.
  static func projectKey(_ project: ProjectSummary) -> String {
    if let id = project.logicalProjectId { return "linked:\(id)" }
    if let folder = project.members.compactMap(\.folder).filter({ !$0.isEmpty }).min() { return "folder:\(folder)" }
    return "copy:\(project.ref.environmentId):\(project.ref.projectId)"
  }

  private static func ref(_ saved: String) -> ProjectRef? {
    let parts = saved.split(separator: "\n", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return nil }
    return ProjectRef(environmentId: parts[0], projectId: parts[1])
  }
}
