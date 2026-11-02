import Foundation

/// What a `studio://thread/` link names, with the rules of the desktop chip
/// (`apps/web/src/studio/studioThreadLinks.ts`, `StudioThreadLink.tsx`).
/// It reads each machine's whole thread list: a coordinator's workers are subagents,
/// and they are not in the drawer's lists. Archived threads come from a second read.
public enum ThreadLinkResolver {
  public struct Thread: Sendable {
    let id: String
    let title: String
    let isDeleted: Bool
    public init(id: String, title: String, isDeleted: Bool) {
      self.id = id
      self.title = title
      self.isDeleted = isDeleted
    }
  }

  public struct Machine: Sendable {
    let environmentId: String
    /// Nil until the machine has answered: nothing can say a thread is missing yet.
    let threads: [Thread]?
    public init(environmentId: String, threads: [Thread]?) {
      self.environmentId = environmentId
      self.threads = threads
    }
  }

  enum Resolution: Equatable {
    case thread(ThreadRef)
    case deleted
    case unpairedMachine
    case stillLoading
    case missing
  }

  /// - Parameters:
  ///   - candidates: IDs the link may name, most likely first.
  ///   - environmentId: The machine the link names; a named machine is never left for another.
  ///   - titles: A thread's title where the ID belongs; only a title one thread has counts.
  ///   - origin: The machine whose conversation holds the link.
  static func resolve(candidates: [String], environmentId: String?, titles: [String], origin: String, machines: [Machine]) -> Resolution {
    if let environmentId {
      guard let machine = machines.first(where: { $0.environmentId == environmentId }) else {
        // A first segment that is not a machine ID is a title with a slash in it.
        return looksLikeEnvironmentId(environmentId) ? .unpairedMachine : resolve(candidates: [], environmentId: nil, titles: titles.filter { !candidates.contains($0) }, origin: origin, machines: machines)
      }
      return exact(candidates, on: machine) ?? titled(titles, on: [machine]) ?? (machine.threads == nil ? open(candidates, on: machine) : .missing)
    }
    let local = machines.first { $0.environmentId == origin }
    if let local, let found = exact(candidates, on: local) { return found }
    // A coordinator names workers it started on another machine with a bare link.
    for machine in machines where machine.environmentId != origin {
      if case let .thread(ref)? = exact(candidates, on: machine) { return .thread(ref) }
    }
    if let local, let found = titled(titles, on: [local]) { return found }
    if let found = titled(titles, on: machines) { return found }
    if let local, local.threads == nil { return open(candidates, on: local) }
    // Nothing can say the thread is missing until every machine has answered.
    return machines.contains { $0.threads == nil } ? .stillLoading : .missing
  }

  private static func exact(_ candidates: [String], on machine: Machine) -> Resolution? {
    guard let threads = machine.threads else { return nil }
    for candidate in candidates {
      if threads.contains(where: { $0.id == candidate && !$0.isDeleted }) {
        return .thread(ThreadRef(environmentId: machine.environmentId, threadId: candidate))
      }
    }
    return threads.contains { candidates.contains($0.id) } ? .deleted : nil
  }

  private static func titled(_ titles: [String], on machines: [Machine]) -> Resolution? {
    for title in titles {
      let wanted = title.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !wanted.isEmpty else { continue }
      let matches = machines.flatMap { machine in
        (machine.threads ?? [])
          .filter { !$0.isDeleted && $0.title.trimmingCharacters(in: .whitespacesAndNewlines) == wanted }
          .map { ThreadRef(environmentId: machine.environmentId, threadId: $0.id) }
      }
      if matches.count == 1 { return .thread(matches[0]) }
    }
    return nil
  }

  /// The chat itself shows the machine's connection state.
  private static func open(_ candidates: [String], on machine: Machine) -> Resolution {
    candidates.first.map { .thread(ThreadRef(environmentId: machine.environmentId, threadId: $0)) } ?? .missing
  }

  /// `machines` with each machine's archived threads added.
  static func merging(_ archived: [Machine], into machines: [Machine]) -> [Machine] {
    machines.map { machine in
      guard let extra = archived.first(where: { $0.environmentId == machine.environmentId })?.threads, !extra.isEmpty else { return machine }
      return Machine(environmentId: machine.environmentId, threads: (machine.threads ?? []) + extra)
    }
  }

  private static func looksLikeEnvironmentId(_ value: String) -> Bool {
    UUID(uuidString: value) != nil
  }
}
