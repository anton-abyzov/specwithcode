import Foundation

// Sample data for previews, UI tests and simulator screenshots. Nothing here
// talks to a machine: sends echo and stream a short canned reply, actions
// change the summaries in memory, and settings live for the app session.

public enum FixtureScenario: String, Sendable, CaseIterable {
  /// Three machines, Aide, four projects and fourteen threads.
  case `default`
  /// No machines yet, as on first launch.
  case empty
  /// Like `default`, but every opened chat is mid-run with one queued message.
  case running
  /// One project linked across M4 and Minis; one thread lives on M4 and runs
  /// on Minis.
  case fleet
  /// `fleet`, then M4 goes offline mid-session and comes back.
  case m4Blip = "m4-blip"
  /// `fleet`, then Minis goes offline and comes back.
  case minisBlip = "minis-blip"
  /// Like `default`, but Aide's chat holds a long history with links, for
  /// scroll, link and app lifecycle checks on a simulator.
  case long
  /// Rich text, thread navigation and explicitly simulated ledger states.
  case checkOutput = "check-output"
  case readability
  case threadLists = "thread-lists"
  /// Duplicate project registrations on the same machine (e.g. trailing slash
  /// or re-registered folder), built from shells as the live engine does;
  /// the drawer shows each unique project once.
  case duplicates

  var isFleet: Bool { self == .fleet || self == .m4Blip || self == .minisBlip }
}

@MainActor
public final class FixtureEngine: AppEngine {
  public let scenario: FixtureScenario
  /// Pause between streamed chunks of a fake reply. Tests set it to zero.
  public var streamDelay: Duration = .milliseconds(45)
  /// Simulated round trip for pairing, settings and reconnects.
  public var latency: Duration = .milliseconds(450)

  private weak var model: AppModel?
  private var transcripts: [ChatTarget: [TranscriptRow]] = [:]
  private var openSessions: [ChatTarget: ChatSession] = [:]
  private var replies: [ChatTarget: Task<Void, Never>] = [:]
  private var running: Set<ChatTarget> = []
  private var queued: [ChatTarget: Int] = [:]
  private var projectSettings: [ProjectRef: ProjectSettingsDraft] = [:]
  private var machineSettings: [String: MachineSettings] = [:]
  /// Machines that stay offline when asked to reconnect.
  private var unreachable: Set<String> = []
  /// When the phone last had each offline machine connected.
  private var lastSeen: [String: Date] = [:]
  /// Threads that run on another machine than the one they live on.
  private var runsOn: [ThreadRef: String] = [:]
  /// Pause before each step of a blip scenario: the machine drops after one
  /// step and comes back after two. Tests set it to zero.
  public var faultStep: Duration = .seconds(6)
  private var counter = 0
  private var continuedThreads: [ThreadRef: ThreadRef] = [:]

  public init(scenario: FixtureScenario = .default) {
    self.scenario = scenario
  }

  // Simulated handoff updates the same in-memory summaries and transcript the UI reads.
  // It is not evidence of a remote provider executing.
  func fixtureHandoffOptions(for thread: ThreadRef) -> HandoffOptions {
    guard let model, let summary = model.thread(thread), scenario.isFleet else {
      return HandoffOptions(badge: nil, destinations: [], notices: ["Sample data has no linked destination for this thread."])
    }
    if continuedThreads[thread] != nil {
      return HandoffOptions(badge: "continued", destinations: [], notices: [LiveEngine.handedOffReason])
    }
    let candidates = model.machines.filter { $0.id != thread.environmentId }
    let destinations = candidates.filter { $0.status.isOnline }.map {
      HandoffDestination(id: $0.id, name: $0.label, usesReplica: !summary.machineOnline)
    }
    return HandoffOptions(badge: "ready", destinations: destinations,
      notices: ["Sample preview. No real machine or provider will run."] + candidates.filter { !$0.status.isOnline }.map { "\($0.label): offline or unreachable from this phone." })
  }

  func simulateHandoff(_ thread: ThreadRef, to destination: HandoffDestination) async throws -> ThreadRef {
    if let existing = continuedThreads[thread] { return existing }
    guard let model, let original = model.thread(thread), let project = original.projectRef,
      fixtureHandoffOptions(for: thread).destinations.contains(destination) else {
      throw FixtureFailure("This destination cannot continue the sample thread.")
    }
    try await Task.sleep(for: latency * 3)
    try requireOnline(destination.id, doing: "continue the thread")
    let next = ThreadRef(environmentId: destination.id, threadId: "continued-" + thread.threadId)
    let sourceTarget = ChatTarget.thread(thread)
    let nextTarget = ChatTarget.thread(next)
    replies[sourceTarget]?.cancel()
    replies[sourceTarget] = nil
    running.remove(sourceTarget)
    let rows = transcripts[sourceTarget] ?? initialTranscript(for: sourceTarget)
    transcripts[nextTarget] = rows.map { original in
      var row = Self.finished(original)
      switch row.kind {
      case let .approval(_, prompt, _), let .question(_, prompt, _):
        row.kind = .notice(text: "Previous machine request (historical): " + prompt)
      case let .plan(steps):
        row.kind = .plan(steps: steps.map { step in
          var step = step
          if step.status == .running { step.status = .pending }
          return step
        })
      default: break
      }
      return row
    } + [row("handoff", .assistant(markdown: "**Sample continuation on \(destination.name).** The conversation and checkpoint are represented here. No real provider has started; send a sample message to try the composer.", streaming: false))]
    continuedThreads[thread] = next
    let moved = ThreadSummary(ref: next, projectRef: project, projectTitle: original.projectTitle,
      title: original.title, activity: .idle, preview: "Sample continuation", updatedAt: Date(),
      machineLabel: destination.name, machineOnline: true, planProgress: original.planProgress,
      placement: ThreadPlacement(owner: destination.name))
    model.threadsByProject[project, default: []].append(moved)
    updateThread(thread) { $0.activity = .idle; $0.placement.runsOn = destination.name }
    recompute()
    return next
  }

  // MARK: AppEngine

  public func start(model: AppModel) {
    self.model = model
    defer { model.isLoading = false }
    guard scenario != .empty else { return }
    let now = Date()
    if scenario.isFleet {
      model.machines = FixtureFleet.machines
      model.projects = [FixtureFleet.project]
      model.threadsByProject = [FixtureFleet.onM4: FixtureFleet.threads(now: now)]
      runsOn = FixtureFleet.runsOn
      recompute()
      runBlip()
      return
    }
    if scenario == .duplicates {
      let output = FixtureDuplicates.output(now: now)
      model.machines = FixtureDuplicates.machines
      model.projects = output.projects
      model.threadsByProject = output.threadsByProject
      recompute()
      return
    }
    model.machines = FixtureSample.machines
    unreachable = [FixtureSample.travel]
    lastSeen = [FixtureSample.travel: now.addingTimeInterval(-26 * 3600)]
    model.aide = FixtureSample.aide
    model.projects = FixtureSample.projects
    var threads = FixtureSample.threads(now: now)
    if scenario == .threadLists {
      threads = Array(threads.prefix(6))
      for i in threads.indices {
        let days = [0, 1, 4, 12, 40, 45][i]
        let at = Calendar.current.date(byAdding: .day, value: -days, to: now)!
        threads[i].activityAt = at
        threads[i].updatedAt = at
      }
    }
    model.threadsByProject = Dictionary(grouping: threads) { $0.projectRef ?? FixtureSample.specweave }
    recompute()
  }

  public func setActive(_ active: Bool) {}

  public func pair(link: String) async throws -> MachineSummary {
    try await pair(link: link, expectedEnvironmentId: nil)
  }

  public func pair(link: String, expectedEnvironmentId: String?) async throws -> MachineSummary {
    let trimmed = link.trimmingCharacters(in: .whitespacesAndNewlines)
    await pause(latency)
    guard !trimmed.isEmpty, !trimmed.lowercased().contains("bad") else {
      throw FixtureFailure("This pairing link didn't work. It may have expired or been used already. Create a new one in SpecWithCode on your computer and try again.")
    }
    guard let model else { throw FixtureFailure("SpecWithCode isn't ready yet. Try again in a moment.") }
    let url = URL(string: trimmed)
    let host = url?.host()
    let address = host.map { h in "\(url?.scheme ?? "https")://\(h)\(url?.port.map { ":\($0)" } ?? "")" }
    if let expectedEnvironmentId, address == nil || model.machines.first(where: { $0.address == address })?.id != expectedEnvironmentId {
      let label = model.machine(expectedEnvironmentId)?.label ?? "this machine"
      throw FixtureFailure("This pairing link is for a different machine. Create one in SpecWithCode on \(label) and try again.")
    }
    if let address, let index = model.machines.firstIndex(where: { $0.address == address }) {
      model.machines[index].status = .connected
      model.machines[index].tokenDaysLeft = 30
      unreachable.remove(model.machines[index].id)
      recompute()
      return model.machines[index]
    }
    counter += 1
    let machine = MachineSummary(
      id: "env-paired-\(counter)",
      label: Self.label(forHost: host),
      status: .connected,
      platform: "macOS · arm64",
      serverVersion: "0.42.1",
      address: address,
      tokenDaysLeft: 30
    )
    model.machines.append(machine)
    recompute()
    return machine
  }

  public func removeMachine(id: String) {
    guard let model else { return }
    model.machines.removeAll { $0.id == id }
    model.projects.removeAll { $0.ref.environmentId == id }
    model.threadsByProject = model.threadsByProject.filter { $0.key.environmentId != id }
    if model.aide?.ref.environmentId == id { model.aide = nil }
    unreachable.remove(id)
    recompute()
  }

  public func reconnect(machineId: String) {
    guard let model, let index = model.machines.firstIndex(where: { $0.id == machineId }) else { return }
    model.machines[index].status = .reconnecting
    recompute()
    let delay = latency * 2
    Task { [weak self] in
      try? await Task.sleep(for: delay)
      self?.finishReconnect(machineId)
    }
  }

  public func open(_ session: ChatSession) {
    let target = session.id
    openSessions[target] = session
    if transcripts[target] == nil { transcripts[target] = initialTranscript(for: target) }
    if scenario == .running, replies[target] == nil, !running.contains(target) {
      running.insert(target)
      queued[target] = 1
      if !(transcripts[target]?.last.map(Self.isRunningTool) ?? false) {
        transcripts[target, default: []].append(row("t", .tool(title: "Running npm test", detail: "vitest run --reporter dot", symbol: "terminal", status: .running)))
      }
    }
    if case let .thread(ref) = target { updateThread(ref) { $0.isUnread = false } }
    refresh(target)
  }

  public func close(_ session: ChatSession) {
    openSessions[session.id] = nil
  }

  public func send(_ text: String, to target: ChatTarget) async throws {
    guard let model else { throw FixtureFailure("SpecWithCode isn't ready yet. Try again in a moment.") }
    if case let .thread(ref) = target, continuedThreads[ref] != nil { throw FixtureFailure(LiveEngine.handedOffReason) }
    let machine = model.machine(target.environmentId)
    guard machine?.status.isOnline == true else {
      throw FixtureFailure("\(machine?.label ?? "This machine") is offline, so the message wasn't sent. Try again when it reconnects.")
    }
    if transcripts[target] == nil { transcripts[target] = initialTranscript(for: target) }
    let queues = running.contains(target)
    transcripts[target, default: []].append(row("u", .user(text: text, state: queues ? .queued : .sent)))
    touch(target, preview: text, activity: .working)
    if queues {
      queued[target, default: 0] += 1
      refresh(target)
      return
    }
    running.insert(target)
    startReply(Self.reply(for: target), in: target)
  }

  public func stop(_ target: ChatTarget) async throws {
    replies[target]?.cancel()
    replies[target] = nil
    guard running.remove(target) != nil else { return }
    transcripts[target] = transcripts[target]?.map(Self.finished).map(Self.held)
    let held = queued[target] ?? 0
    transcripts[target, default: []].append(row("n", .notice(text: held > 0 ? "Stopped. \(held) queued message\(held == 1 ? " is" : "s are") on hold." : "Stopped.")))
    touch(target, preview: "Stopped", activity: .idle)
    refresh(target)
  }

  public func respond(to requestId: String, in target: ChatTarget, decision: ApprovalDecision) async throws {
    guard var rows = transcripts[target], let index = rows.firstIndex(where: { Self.requestId(of: $0) == requestId }) else {
      throw FixtureFailure("That request is no longer waiting for an answer.")
    }
    await pause(latency / 3)
    var prompt = ""
    switch rows[index].kind {
    case let .approval(id, text, _):
      prompt = text
      rows[index].kind = .approval(requestId: id, prompt: text, resolved: true)
    case let .question(id, text, _):
      rows[index].kind = .question(requestId: id, prompt: text, resolved: true)
    default:
      break
    }
    transcripts[target] = rows
    if decision == .deny {
      transcripts[target, default: []].append(row("n", .notice(text: "Denied. The run will look for another way.")))
      touch(target, preview: "Approval denied", activity: .idle)
      refresh(target)
      return
    }
    transcripts[target, default: []].append(row("t", .tool(title: "Ran \(prompt)", detail: "Exit code 0", symbol: "terminal", status: .completed)))
    advancePlan(in: target)
    touch(target, preview: "Publishing 3.1.0", activity: .working)
    running.insert(target)
    startReply("Published **3.1.0** to the `next` tag. The release workflow is running; I'll open the release PR once it's green.", in: target)
  }

  public func perform(_ action: ThreadAction, on thread: ThreadRef) async throws {
    guard let model, model.thread(thread) != nil else { throw FixtureFailure("That thread no longer exists.") }
    guard model.machine(thread.environmentId)?.status.isOnline == true else {
      throw FixtureFailure("\(model.machine(thread.environmentId)?.label ?? "Its machine") is offline. Try again when it reconnects.")
    }
    switch action {
    case .pin: updateThread(thread) { $0.isPinned = true }
    case .unpin: updateThread(thread) { $0.isPinned = false }
    case .resolve: updateThread(thread) { $0.isResolved = true }
    case .unresolve: updateThread(thread) { $0.isResolved = false }
    case .markUnread: updateThread(thread) { $0.isUnread = true }
    case let .rename(title):
      let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !clean.isEmpty else { throw FixtureFailure("A thread needs a name.") }
      updateThread(thread) { $0.title = clean }
      openSessions[.thread(thread)]?.title = clean
    case .archive, .delete:
      for key in model.threadsByProject.keys { model.threadsByProject[key]?.removeAll { $0.ref == thread } }
      replies[.thread(thread)]?.cancel()
      replies[.thread(thread)] = nil
      running.remove(.thread(thread))
    }
    recompute()
  }

  public func setupAide() async throws -> ProjectRef {
    guard let model else { throw FixtureFailure("SpecWithCode isn't ready yet. Try again in a moment.") }
    if let aide = model.aide { return aide.ref }
    // Every client puts Aide on the machine with the lowest environment id,
    // offline ones included, and creates nothing while a machine is offline:
    // that machine may already hold Aide.
    guard let machine = model.machines.min(by: { $0.id < $1.id }) else {
      throw FixtureFailure("Connect a machine before setting up Aide.")
    }
    guard model.machines.allSatisfy({ $0.status.isOnline }) else {
      throw FixtureFailure("Aide may already be on a machine that's offline. Reconnect your machines, then try again.")
    }
    await pause(latency)
    let ref = ProjectRef(environmentId: machine.id, projectId: "aide")
    model.aide = ProjectSummary(ref: ref, title: "Aide", icon: .symbol(name: "concierge-bell", color: "violet"), kind: .personal, machineLabel: machine.label, machineOnline: true)
    transcripts[.aide(ref)] = [row("a", .assistant(markdown: "Hi, I'm Aide. Ask me anything, or tell me what to start. I can open threads in any project on \(machine.label).", streaming: false))]
    recompute()
    return ref
  }

  public func loadProjectSettings(_ project: ProjectRef) async throws -> ProjectSettingsDraft {
    await pause(latency / 2)
    let draft = try currentSettings(project)
    try requireOnline(project.environmentId, doing: "load these settings")
    return draft
  }

  public func saveProjectSettings(_ draft: ProjectSettingsDraft, for project: ProjectRef) async throws {
    await pause(latency / 2)
    let current = try currentSettings(project)
    try requireOnline(project.environmentId, doing: "save these settings")
    guard draft.revision == current.revision else {
      throw FixtureFailure("These settings changed on \(model?.machine(project.environmentId)?.label ?? "the machine") while you were editing. Close and reopen them to see the latest.")
    }
    var saved = draft
    saved.title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !saved.title.isEmpty else { throw FixtureFailure("A project needs a name.") }
    saved.revision += 1
    projectSettings[project] = saved
    guard let model else { return }
    if model.aide?.ref == project {
      model.aide?.title = saved.title
      model.aide?.paused = saved.paused
      model.aide?.archived = saved.archived
    } else if let index = model.projects.firstIndex(where: { $0.ref == project }) {
      model.projects[index].title = saved.title
      model.projects[index].paused = saved.paused
      model.projects[index].archived = saved.archived
    }
    for target in [ChatTarget.project(project), .aide(project)] { openSessions[target]?.title = saved.title }
    recompute()
  }

  public func loadMachineSettings(_ machineId: String) async throws -> MachineSettings {
    await pause(latency / 2)
    try requireOnline(machineId, doing: "read its settings")
    return machineSettings[machineId] ?? MachineSettings(defaultRuntimeMode: .autoAcceptEdits, defaultModel: nil)
  }

  public func saveMachineSettings(_ settings: MachineSettings, for machineId: String) async throws {
    await pause(latency / 2)
    try requireOnline(machineId, doing: "save its settings")
    machineSettings[machineId] = settings
  }

  // MARK: State

  private func recompute() {
    guard let model else { return }
    let online = Dictionary(model.machines.map { ($0.id, $0.status.isOnline) }, uniquingKeysWith: { a, _ in a })
    // The machine that answers for a thread: where it lives, then where it runs.
    func unknown(_ thread: ThreadSummary) -> ThreadPlacement.Unknown? {
      let owner = thread.ref.environmentId
      guard let machine = online[owner] == true ? runsOn[thread.ref] : owner, online[machine] != true else { return nil }
      return .init(machine: MachineNickname.shortName(model.machine(machine)?.label ?? thread.machineLabel), lastSeenAt: lastSeen[machine])
    }
    for key in model.threadsByProject.keys {
      guard var list = model.threadsByProject[key] else { continue }
      for i in list.indices {
        list[i].machineOnline = online[list[i].ref.environmentId] ?? false
        list[i].placement.unknown = unknown(list[i])
      }
      list.sort { $0.updatedAt > $1.updatedAt }
      model.threadsByProject[key] = list
    }
    func refreshed(_ project: ProjectSummary) -> ProjectSummary {
      var p = project
      let threads = model.threadsByProject[p.ref] ?? []
      p.workingCount = threads.filter { $0.activity == .working && !$0.isResolved }.count
      p.hasUnread = threads.contains { $0.isUnread }
      p.machineOnline = online[p.ref.environmentId] ?? false
      p.machineLabel = model.machine(p.ref.environmentId)?.label ?? p.machineLabel
      for i in p.members.indices {
        let id = p.members[i].ref.environmentId
        p.members[i].machineOnline = online[id] ?? false
        p.members[i].lastSeenAt = lastSeen[id]
      }
      return p
    }
    model.projects = model.projects.map(refreshed).sorted {
      if $0.isPinned != $1.isPinned { return $0.isPinned }
      return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
    }
    if let aide = model.aide { model.aide = refreshed(aide) }
    let all = model.threadsByProject.values.flatMap { $0 }
    model.recentThreads = Array(all.sorted {
      if $0.isPinned != $1.isPinned { return $0.isPinned }
      return $0.updatedAt > $1.updatedAt
    }.prefix(10))
    for target in openSessions.keys { refresh(target) }
  }

  private func refresh(_ target: ChatTarget) {
    guard let session = openSessions[target], let model else { return }
    let rows = transcripts[target] ?? []
    let machine = model.machine(target.environmentId)
    let online = machine?.status.isOnline ?? false
    session.rows = rows
    session.isLoaded = true
    session.isRunning = running.contains(target)
    session.queuedCount = queued[target] ?? 0
    session.plan = Self.plan(in: rows, running: running.contains(target))
    session.machineLabel = machine?.label ?? ""
    session.machineOnline = online
    session.isStale = !online
    session.sendBlockedReason = online ? nil : "\(machine?.label ?? "This machine") is offline. You can send again when it reconnects."
    if case let .thread(ref) = target, continuedThreads[ref] != nil { session.sendBlockedReason = LiveEngine.handedOffReason }
    switch target {
    case let .aide(ref), let .project(ref):
      if let project = model.project(ref) { session.title = project.title }
      session.subtitle = "Coordinator · \(machine.map { MachineNickname.shortName($0.label) } ?? "machine")"
    case let .thread(ref):
      if let thread = model.thread(ref) {
        session.title = thread.title
        session.subtitle = thread.projectTitle ?? "Thread"
      }
    }
  }

  private func finishReconnect(_ machineId: String) {
    guard let model, let index = model.machines.firstIndex(where: { $0.id == machineId }) else { return }
    model.machines[index].status = unreachable.contains(machineId) ? .offline : .connected
    recompute()
  }

  /// Drops the blip scenario's machine mid-session, then brings it back.
  private func runBlip() {
    let machine: String
    switch scenario {
    case .m4Blip: machine = FixtureFleet.m4
    case .minisBlip: machine = FixtureFleet.minis
    default: return
    }
    let step = faultStep
    Task { [weak self] in
      try? await Task.sleep(for: step)
      self?.setReachable(machine, false)
      try? await Task.sleep(for: step)
      self?.setReachable(machine, true)
    }
  }

  private func setReachable(_ machineId: String, _ reachable: Bool) {
    guard let model, let index = model.machines.firstIndex(where: { $0.id == machineId }) else { return }
    if reachable {
      unreachable.remove(machineId)
      model.machines[index].status = .connected
    } else {
      unreachable.insert(machineId)
      lastSeen[machineId] = Date()
      model.machines[index].status = .offline
    }
    recompute()
  }

  private func updateThread(_ ref: ThreadRef, _ change: (inout ThreadSummary) -> Void) {
    guard let model else { return }
    for key in model.threadsByProject.keys {
      guard let index = model.threadsByProject[key]?.firstIndex(where: { $0.ref == ref }) else { continue }
      change(&model.threadsByProject[key]![index])
    }
    recompute()
  }

  private func touch(_ target: ChatTarget, preview: String, activity: ThreadActivity) {
    guard case let .thread(ref) = target else { return }
    let line = preview.split(separator: "\n").first.map(String.init) ?? preview
    updateThread(ref) {
      $0.preview = line.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "`", with: "")
      $0.updatedAt = Date()
      if activity == .working, $0.activity != .working { $0.workStartedAt = Date() }
      if activity == .idle { $0.workStartedAt = nil }
      $0.activity = activity
    }
  }

  private func currentSettings(_ project: ProjectRef) throws -> ProjectSettingsDraft {
    if let saved = projectSettings[project] { return saved }
    guard let summary = model?.project(project) else { throw FixtureFailure("This project is no longer available.") }
    let draft = ProjectSettingsDraft(
      title: summary.title,
      goal: FixtureSample.goal(for: project.projectId),
      instructions: project.projectId == FixtureSample.specweave.projectId ? "Keep pull requests small. Run the full test suite before asking for a merge." : "",
      paused: summary.paused,
      archived: summary.archived,
      coordinatorModel: "Default",
      revision: 1
    )
    projectSettings[project] = draft
    return draft
  }

  private func requireOnline(_ machineId: String, doing action: String) throws {
    let machine = model?.machine(machineId)
    guard machine?.status.isOnline == true else {
      throw FixtureFailure("\(machine?.label ?? "That machine") is offline. Connect it to \(action).")
    }
  }

  // MARK: Replies

  private func startReply(_ text: String, in target: ChatTarget) {
    let id = nextId("a")
    transcripts[target, default: []].append(TranscriptRow(id: id, kind: .assistant(markdown: "", streaming: true)))
    refresh(target)
    replies[target] = Task { [weak self] in
      await self?.stream(text, rowId: id, in: target)
    }
  }

  private func stream(_ text: String, rowId: String, in target: ChatTarget) async {
    guard await pause(streamDelay * 8) else { return }
    let chunks = Self.chunks(of: text)
    var shown = ""
    for chunk in chunks {
      shown += chunk
      setAssistant(rowId, in: target, markdown: shown, streaming: true)
      guard await pause(streamDelay) else { return }
    }
    setAssistant(rowId, in: target, markdown: text, streaming: false)
    replies[target] = nil
    if let waiting = queued[target], waiting > 0 {
      queued[target] = waiting - 1
      startQueuedMessage(in: target)
      startReply(Self.reply(for: target), in: target)
    } else {
      running.remove(target)
      touch(target, preview: text, activity: .idle)
      refresh(target)
    }
  }

  /// The oldest queued message's run starts.
  private func startQueuedMessage(in target: ChatTarget) {
    guard let index = transcripts[target]?.firstIndex(where: {
      if case let .user(_, state) = $0.kind { state == .queued || state == .held } else { false }
    }), case let .user(text, _)? = transcripts[target]?[index].kind else { return }
    transcripts[target]?[index].kind = .user(text: text, state: .sent)
  }

  private func setAssistant(_ id: String, in target: ChatTarget, markdown: String, streaming: Bool) {
    guard let index = transcripts[target]?.firstIndex(where: { $0.id == id }) else { return }
    transcripts[target]?[index].kind = .assistant(markdown: markdown, streaming: streaming)
    refresh(target)
  }

  private func advancePlan(in target: ChatTarget) {
    guard var rows = transcripts[target], let index = rows.lastIndex(where: { if case .plan = $0.kind { true } else { false } }),
          case var .plan(steps) = rows[index].kind else { return }
    if let i = steps.firstIndex(where: { $0.status == .running }) {
      steps[i].status = .completed
      if i + 1 < steps.count { steps[i + 1].status = .running }
    }
    rows[index].kind = .plan(steps: steps)
    transcripts[target] = rows
    if case let .thread(ref) = target {
      let done = steps.filter { $0.status == .completed }.count
      updateThread(ref) { $0.planProgress = PlanProgress(completed: done, total: steps.count) }
    }
  }

  /// Returns false when the task was cancelled.
  @discardableResult
  private func pause(_ duration: Duration) async -> Bool {
    if duration > .zero { try? await Task.sleep(for: duration) } else { await Task.yield() }
    return !Task.isCancelled
  }

  private func nextId(_ prefix: String) -> String {
    counter += 1
    return "\(prefix)-\(counter)"
  }

  private func row(_ prefix: String, _ kind: TranscriptRow.Kind) -> TranscriptRow {
    TranscriptRow(id: nextId(prefix), kind: kind)
  }

  // MARK: Transcripts

  private func initialTranscript(for target: ChatTarget) -> [TranscriptRow] {
    if scenario == .checkOutput { return Self.checkOutputRows.map { row("check-output", $0) } }
    if scenario == .readability { return Self.readabilityRows.map { row("readability", $0) } }
    switch target {
    case .aide:
      let rows = scenario == .long ? FixtureSample.longAideTranscript : FixtureSample.aideTranscript
      return rows.map { row("a", $0) }
    case let .project(ref):
      let title = model?.project(ref)?.title ?? "this project"
      let threads = model?.threads(in: ref) ?? []
      let working = threads.filter { $0.activity == .working }.count
      let needs = threads.filter { $0.activity == .needsYou }.count
      var summary = "Here's where **\(title)** stands: \(working) working, \(needs) waiting for you, \(threads.count - working - needs) idle."
      if let first = threads.first(where: { $0.activity == .needsYou }) {
        summary += "\n\n*\(first.title)* needs an answer before it can continue."
      }
      return [row("u", .user(text: "What's the status?")), row("a", .assistant(markdown: summary, streaming: false))]
    case let .thread(ref):
      if ref.threadId == "t-release" { return FixtureSample.releaseTranscript.map { row("r", $0) } }
      guard let thread = model?.thread(ref) else {
        return [row("n", .notice(text: "No messages yet."))]
      }
      var rows: [TranscriptRow] = [row("u", .user(text: thread.title))]
      if let progress = thread.planProgress {
        rows.append(row("p", .plan(steps: FixtureSample.steps(progress))))
      }
      switch thread.activity {
      case .working:
        rows.append(row("t", .tool(title: "Read the open increment", detail: ".specweave/increments/spec.md", symbol: "doc.text", status: .completed)))
        rows.append(row("t", .tool(title: thread.preview ?? "Working", detail: nil, symbol: "terminal", status: .running)))
        running.insert(target)
      case .failed:
        rows.append(row("t", .tool(title: "Ran npm test", detail: "3 files failed · exit code 1", symbol: "terminal", status: .failed)))
        rows.append(row("e", .error(message: thread.preview ?? "The run failed.")))
      case .needsYou:
        rows.append(row("q", .approval(requestId: "req-\(ref.threadId)", prompt: "git push origin HEAD", resolved: false)))
      case .idle:
        rows.append(row("a", .assistant(markdown: thread.preview ?? "Done.", streaming: false)))
      }
      return rows
    }
  }

  private static func reply(for target: ChatTarget) -> String {
    switch target {
    case .aide:
      "Sure. I'll take care of that and let you know here when it's done."
    case .project:
      "On it. I'll start a thread for this and report back once it has a plan.\n\n- Read the open increment\n- Split the work into tasks\n- Start the first task"
    case .thread:
      "Got it. I'll fold that into the current work.\n\nNext I'll run the checks again and post the results here."
    }
  }

  private static func chunks(of text: String) -> [String] {
    var words: [String] = []
    var current = ""
    for character in text {
      current.append(character)
      if character == " " || character == "\n" {
        words.append(current)
        current = ""
      }
    }
    if !current.isEmpty { words.append(current) }
    return stride(from: 0, to: words.count, by: 2).map { words[$0..<min($0 + 2, words.count)].joined() }
  }

  private static func plan(in rows: [TranscriptRow], running: Bool) -> PlanProgress? {
    for row in rows.reversed() {
      if case let .plan(steps) = row.kind, !steps.isEmpty {
        let done = steps.filter { $0.status == .completed }.count
        return done < steps.count || running ? PlanProgress(completed: done, total: steps.count) : nil
      }
    }
    return nil
  }

  private static func finished(_ row: TranscriptRow) -> TranscriptRow {
    var row = row
    switch row.kind {
    case let .assistant(markdown, true): row.kind = .assistant(markdown: markdown, streaming: false)
    case let .reasoning(text, true, seconds): row.kind = .reasoning(text: text, streaming: false, seconds: seconds)
    case let .tool(title, detail, symbol, .running): row.kind = .tool(title: title, detail: detail, symbol: symbol, status: .failed)
    default: break
    }
    return row
  }

  /// Stop holds the queue: queued messages wait until it is resumed.
  private static func held(_ row: TranscriptRow) -> TranscriptRow {
    var row = row
    if case let .user(text, .queued) = row.kind { row.kind = .user(text: text, state: .held) }
    return row
  }

  private static func isRunningTool(_ row: TranscriptRow) -> Bool {
    if case .tool(_, _, _, .running) = row.kind { return true }
    return false
  }

  private static func requestId(of row: TranscriptRow) -> String? {
    switch row.kind {
    case let .approval(id, _, _), let .question(id, _, _): id
    default: nil
    }
  }

  static func label(forHost host: String?) -> String {
    guard let host, !host.isEmpty else { return "New machine" }
    if host.allSatisfy({ $0.isNumber || $0 == "." || $0 == ":" }) { return "Machine at \(host)" }
    let name = (host.split(separator: ".").first.map(String.init) ?? host).replacingOccurrences(of: "-", with: " ")
    return name.prefix(1).uppercased() + name.dropFirst()
  }
}

private struct FixtureFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

// MARK: - Sample data

private enum FixtureSample {
  static let studio = "env-studio-mac"
  static let buildBox = "env-build-box"
  static let travel = "env-travel-laptop"

  static let specweave = ProjectRef(environmentId: studio, projectId: "specweave")
  static let verified = ProjectRef(environmentId: studio, projectId: "verified-skill")
  static let recipes = ProjectRef(environmentId: buildBox, projectId: "recipe-app")
  static let docs = ProjectRef(environmentId: travel, projectId: "docs-site")

  static let machines: [MachineSummary] = [
    MachineSummary(id: studio, label: "Office Mac", status: .connected, platform: "macOS · arm64", serverVersion: "0.42.1", address: "https://studio-mac.local:3773", tokenDaysLeft: 24),
    MachineSummary(id: buildBox, label: "Build box", status: .connected, platform: "Linux · x64", serverVersion: "0.42.1", address: "https://build-box.local:3773", tokenDaysLeft: 3),
    MachineSummary(id: travel, label: "Travel laptop", status: .offline, platform: "macOS · arm64", serverVersion: "0.41.0", address: "http://192.168.1.24:3773", tokenDaysLeft: 12),
  ]

  static let aide = ProjectSummary(
    ref: ProjectRef(environmentId: studio, projectId: "aide"),
    title: "Aide",
    icon: .symbol(name: "concierge-bell", color: "violet"),
    kind: .personal,
    machineLabel: "Office Mac",
    machineOnline: true
  )

  static let projects: [ProjectSummary] = [
    ProjectSummary(ref: specweave, title: "SpecWeave", icon: .symbol(name: "dna", color: "amber"), machineLabel: "Office Mac", machineOnline: true, isPinned: true),
    ProjectSummary(ref: verified, title: "Verified Skill", icon: .symbol(name: "shield-check", color: "green"), machineLabel: "Office Mac", machineOnline: true, isPinned: true),
    ProjectSummary(ref: recipes, title: "Recipe app", icon: .symbol(name: "utensils", color: "orange"), machineLabel: "Build box", machineOnline: true),
    ProjectSummary(ref: docs, title: "Docs site", icon: .symbol(name: "book-open", color: "blue"), machineLabel: "Travel laptop", machineOnline: false),
  ]

  static func threads(now: Date) -> [ThreadSummary] {
    func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
    func thread(_ id: String, _ project: ProjectRef, _ projectTitle: String, _ machine: String, _ title: String, _ activity: ThreadActivity, _ preview: String, updated: Double, started: Double? = nil, pinned: Bool = false, resolved: Bool = false, unread: Bool = false, plan: (Int, Int)? = nil) -> ThreadSummary {
      ThreadSummary(
        ref: ThreadRef(environmentId: project.environmentId, threadId: id),
        projectRef: project,
        projectTitle: projectTitle,
        title: title,
        activity: activity,
        preview: preview,
        updatedAt: ago(updated),
        workStartedAt: started.map(ago),
        isPinned: pinned,
        isResolved: resolved,
        isUnread: unread,
        machineLabel: machine,
        machineOnline: project.environmentId != travel,
        planProgress: plan.map { PlanProgress(completed: $0.0, total: $0.1) },
        identity: id == "t-handoff" ? ThreadIdentity(provider: "Codex", model: "GPT-6.1 Sol", providerBrand: "openai", modelBrand: "openai")
          : id == "t-ledger" ? ThreadIdentity(provider: "GitHub Copilot", model: "Opus 5.5", providerBrand: "copilot", modelBrand: "claude")
          : ThreadIdentity(provider: "Claude Code", model: "Opus 5.5", providerBrand: "claude", modelBrand: "claude")
      )
    }
    return [
      thread("t-release", specweave, "SpecWeave", "Office Mac", "Release 3.1 checklist", .needsYou, "Wants to run npm publish --tag next", updated: 1, started: 9, unread: true, plan: (3, 5)),
      thread("t-handoff", specweave, "SpecWeave", "Office Mac", "Write handoff docs for cross-tool pickup", .working, "Editing docs/handoff.md", updated: 0.5, started: 2, plan: (2, 5)),
      thread("t-ledger", specweave, "SpecWeave", "Office Mac", "Fix ledger merge conflicts", .working, "Running the ledger tests", updated: 3, started: 14, plan: (3, 4)),
      thread("t-flaky", specweave, "SpecWeave", "Office Mac", "Investigate flaky end-to-end run", .failed, "npm test exited with code 1 in 3 files", updated: 40),
      thread("t-verify-gate", specweave, "SpecWeave", "Office Mac", "Add verify gate to CI", .idle, "PR #42 open; waiting for checks", updated: 120, pinned: true),
      thread("t-changelog", specweave, "SpecWeave", "Office Mac", "Draft changelog for 3.0.24", .idle, "Changelog merged in #39", updated: 1440, resolved: true),
      thread("t-ranking", verified, "Verified Skill", "Office Mac", "Improve skill search ranking", .working, "Comparing ranking results", updated: 2, started: 6, plan: (1, 3)),
      thread("t-dedupe", verified, "Verified Skill", "Office Mac", "Deduplicate skill imports", .idle, "Tests pass; ready to merge", updated: 25, unread: true),
      thread("t-crawler", verified, "Verified Skill", "Office Mac", "Crawler retry backoff", .idle, "Shipped in 1.4.2", updated: 4320, resolved: true),
      thread("t-offline", recipes, "Recipe app", "Build box", "Offline mode for saved recipes", .working, "Writing the sync queue", updated: 4, started: 48, plan: (4, 6)),
      thread("t-onboarding", recipes, "Recipe app", "Build box", "Polish onboarding screens", .idle, "Screenshots attached for review", updated: 300),
      thread("t-images", recipes, "Recipe app", "Build box", "Shrink the image cache", .idle, "Cache now capped at 200 MB", updated: 1500),
      thread("t-search-index", docs, "Docs site", "Travel laptop", "Rebuild the search index", .idle, "Index rebuilt; 1,284 pages", updated: 2880),
      thread("t-links", docs, "Docs site", "Travel laptop", "Fix broken links after the move", .idle, "12 links fixed; 3 need a decision", updated: 5760),
    ]
  }

  static func goal(for projectId: String) -> String {
    switch projectId {
    case "specweave": "Plan work in a spec, let any tool do it, and keep the record in git. Ship small releases often and keep the docs current."
    case "verified-skill": "Make it easy to find skills that are safe to install, and show why each one can be trusted."
    case "recipe-app": "A recipe app that works offline and makes weekly meal planning quick."
    case "docs-site": "Clear, searchable docs for every release."
    case "aide": "Help with anything across my machines, and start work in the right project."
    default: ""
    }
  }

  static func steps(_ progress: PlanProgress) -> [TodoStep] {
    let names = ["Read the open increment", "Write the failing test", "Make the change", "Run the full test suite", "Update the docs", "Open a pull request"]
    return (0..<progress.total).map { i in
      let status: TodoStep.Status = i < progress.completed ? .completed : (i == progress.completed ? .running : .pending)
      return TodoStep(id: "s\(i)", text: names[i % names.count], status: status)
    }
  }

  static let aideTranscript: [TranscriptRow.Kind] = [
    .user(text: "Good morning. What needs me today?"),
    .assistant(markdown: """
      Good morning. Here's where things stand across your machines.

      **Needs you**
      - *Release 3.1 checklist* in SpecWeave wants approval to publish to npm.

      **Working**
      - *Write handoff docs for cross-tool pickup* (2 of 5 tasks)
      - *Fix ledger merge conflicts* (3 of 4 tasks)
      - *Offline mode for saved recipes* on Build box

      **Heads up**
      - The pairing for Build box expires in 3 days.
      - Travel laptop has been offline since yesterday.
      """, streaming: false),
    .user(text: "Remind me to check the release after lunch."),
    .assistant(markdown: "Done. I'll bring it up at 1:00 PM.", streaming: false),
  ]

  /// Sixty check-ins, oldest first: the oldest message is "Start of history"
  /// and every tenth reply links to the release notes.
  static let longAideTranscript: [TranscriptRow.Kind] = {
    var rows: [TranscriptRow.Kind] = [.user(text: "Start of history"), .assistant(markdown: "Noted. This is where our chat begins.", streaming: false)]
    for day in 1...60 {
      rows.append(.user(text: "Check-in \(day): anything new?"))
      var reply = "Check-in \(day): two threads moved forward and nothing needs you."
      if day % 10 == 0 {
        reply += "\n\nThe [release notes](https://spec-weave.com/docs/whats-new) list what shipped this week."
      }
      rows.append(.assistant(markdown: reply, streaming: false))
    }
    return rows
  }()

  static let releaseTranscript: [TranscriptRow.Kind] = [
    .user(text: "Prepare the 3.1 release. Run the full checks, update the changelog and publish to the next tag when everything passes."),
    .reasoning(text: "The release script lives in scripts/release. Run the checks first, then bump the version and build the changelog from merged pull requests.", streaming: false, seconds: 14),
    .plan(steps: [
      TodoStep(id: "r1", text: "Run the full test suite", status: .completed),
      TodoStep(id: "r2", text: "Update CHANGELOG.md", status: .completed),
      TodoStep(id: "r3", text: "Bump the version to 3.1.0", status: .completed),
      TodoStep(id: "r4", text: "Publish to npm with the next tag", status: .running),
      TodoStep(id: "r5", text: "Open the release pull request", status: .pending),
    ]),
    .tool(title: "Ran npm test", detail: "1,482 passed · 0 failed · 41.2s", symbol: "terminal", status: .completed),
    .tool(title: "Edited CHANGELOG.md", detail: "+38 −2", symbol: "pencil", status: .completed),
    .tool(title: "Ran npm version 3.1.0", detail: "--no-git-tag-version", symbol: "terminal", status: .completed),
    .subagent(title: "Checked the docs for old version numbers", child: ThreadRef(environmentId: studio, threadId: "t-changelog")),
    .assistant(markdown: """
      ## Release 3.1 is ready to publish

      All checks passed on Office Mac. Here's what changed since 3.0.24.

      ### Highlights
      - **Verify gate.** `specweave verify` runs the project's build, test and lint commands and blocks completion when one fails.
      - **Cross-tool handoff.** `specweave handoff` writes a short note that any tool can pick up later.
      - **Faster pickup.** Starting a session reads only the open increment, so large projects start in under a second.

      ### Fixes
      1. Ledger merges keep every line from both sides.
      2. Task counters agree when fields share a line.
      3. The docs build no longer breaks on a bare `<digit` in MDX.

      ### Publish step
      This is what runs next:

      ```bash
      npm publish --tag next
      git tag v3.1.0
      git push origin v3.1.0
      ```

      The package is 1.8 MB with 214 files. Nothing from `.env` files or `.specweave/state` is included; I checked the tarball list.

      ### Checks
      | Check | Result | Time |
      | --- | --- | --- |
      | Unit tests | 1,482 passed | 41s |
      | Lint | Clean | 6s |
      | Docs build | Clean | 18s |
      | Package size | 1.8 MB | — |

      ### After publishing
      - Watch the release workflow until it's green.
      - Move the `latest` tag after a day on `next`.
      - Post the changelog link in the project notes.

      Say the word if you'd like a dry run first.
      """, streaming: false),
    .approval(requestId: "req-publish", prompt: "npm publish --tag next", resolved: false),
  ]
}
