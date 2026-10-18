import Foundation
import SWCWire
import SWCSync

enum TestData {
  static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try WireCoding.decoder.decode(T.self, from: Data(json.utf8))
  }

  static func date(_ iso: String) -> Date {
    WireCoding.parseDate(iso)!
  }

  /// `v2Project` in the TypeScript tests.
  static func project(id: String = "proj_1", title: String? = nil, root: String? = nil, identity: RepositoryIdentity? = nil) throws -> ProjectShell {
    var project = try decode(ProjectShell.self, FixtureJSON.project)
    project.id = id
    if let title { project.title = title }
    if let root { project.workspaceRoot = root }
    project.repositoryIdentity = identity
    return project
  }

  /// `v2ThreadShell` in the TypeScript tests.
  static func thread(id: String = "thr_1", projectId: String = "proj_1", title: String? = nil, updatedAt: String? = nil) throws -> ThreadShell {
    var thread = try decode(ThreadShell.self, FixtureJSON.threadShell)
    thread.id = id
    thread.projectId = projectId
    if let title { thread.title = title }
    if let updatedAt { thread.updatedAt = date(updatedAt) }
    return thread
  }

  /// `v2ShellSnapshot` in the TypeScript tests: one project and one thread at sequence 0.
  static func shell(sequence: Int = 0, threads: [ThreadShell]? = nil, projects: [ProjectShell]? = nil) throws -> ShellSnapshot {
    ShellSnapshot(snapshotSequence: sequence, threads: try threads ?? [thread()], projects: try projects ?? [project()])
  }

  static let identity = RepositoryIdentity(canonicalKey: "github.com/example/repo")
  static let otherIdentity = RepositoryIdentity(canonicalKey: "github.com/example/other")

  static func threadSnapshot() throws -> ThreadStreamItem {
    try decode(ThreadStreamItem.self, FixtureJSON.threadSnapshot)
  }

  static func threadEvents() throws -> [ThreadStreamItem] {
    try decode([ThreadStreamItem].self, FixtureJSON.threadEvents)
  }

  /// The event at `index` of threadEvents.json.
  static func event(_ index: Int) throws -> (sequence: Int, event: DomainEvent) {
    guard case let .event(sequence, event) = try threadEvents()[index] else {
      throw FixtureError("Item \(index) is not an event")
    }
    return (sequence, event)
  }

  static func turnItems() throws -> [TurnItem] {
    try decode([TurnItem].self, FixtureJSON.turnItems)
  }

  static func turnItem(_ id: String) throws -> TurnItem {
    guard let item = try turnItems().first(where: { $0.id == id }) else { throw FixtureError("No item \(id)") }
    return item
  }

  /// A state holding the thread snapshot fixture.
  static func threadState() throws -> ThreadState {
    var state = ThreadState()
    state.apply(try threadSnapshot())
    return state
  }
}

struct FixtureError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}
