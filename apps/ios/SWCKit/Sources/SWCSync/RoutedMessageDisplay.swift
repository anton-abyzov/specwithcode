import Foundation
import SWCWire

/// What a transcript shows for a message the server stored with a routing
/// header. The stored text keeps its header, since routing reads it; only the
/// row changes. Mirrors `packages/shared/src/routedMessage.ts` and
/// `apps/web/src/studio/projectCoordinatorMessageDisplay.ts`.
public enum RoutedMessageDisplay {
  /// A request the personal assistant routed to a project's coordinator.
  public struct RoutedMessage: Equatable, Sendable {
    public var assistantTitle: String
    public var threadId: String
    public var messageId: String
    /// The assistant's own one-line note, such as which part of the request is this project's.
    public var note: String?
    /// The user's words, unchanged.
    public var words: String
  }

  /// A reply typed in a worker on another machine, as earlier versions sent it
  /// to the coordinator.
  public struct ThreadReply: Equatable, Sendable {
    public var threadId: String
    public var environmentId: String
    public var title: String
    public var words: String
  }

  private static let routedHeader = try! NSRegularExpression(
    pattern: #"^Routed from personal assistant "([^"\n]*)" \(thread (\S+), message (\S+)\)\.(?: Assistant note: ([^\n]*?))? The text after this line is the user's own request\.\n\n"#
  )
  private static let threadReplyHeader = try! NSRegularExpression(pattern: #"^Regarding thread (\S+) on machine (\S+) \((.*)\):\n\n"#)
  private static let machineIdShape = try! NSRegularExpression(pattern: "^[0-9a-f-]{8,}$", options: .caseInsensitive)
  private static let coordinatorSendPrefix = "coordinator-send:"

  /// The origin and the user's words, or nil when the text carries no routing header.
  public static func parseRoutedMessage(_ text: String) -> RoutedMessage? {
    guard let groups = match(routedHeader, in: text) else { return nil }
    return RoutedMessage(assistantTitle: groups.captures[0] ?? "", threadId: groups.captures[1] ?? "", messageId: groups.captures[2] ?? "", note: groups.captures[3], words: groups.rest)
  }

  /// The target and the user's words, or nil when the text carries no such header.
  public static func parseRoutedThreadReply(_ text: String) -> ThreadReply? {
    guard let groups = match(threadReplyHeader, in: text) else { return nil }
    return ThreadReply(threadId: groups.captures[0] ?? "", environmentId: groups.captures[1] ?? "", title: groups.captures[2] ?? "", words: groups.rest)
  }

  /// The text to show for a routed reply, without its IDs; other text comes back unchanged.
  public static func routedThreadReplyDisplayText(_ text: String, machineLabel: (String) -> String) -> String {
    guard let reply = parseRoutedThreadReply(text) else { return text }
    let trimmed = reply.title.trimmingCharacters(in: .whitespacesAndNewlines)
    let title = trimmed.isEmpty ? "another thread" : trimmed
    // A machine this device has no name for resolves to its ID, which stays out of sight too.
    // An unnamed one without an ID's shape is a person's own "Regarding thread x on machine y".
    let label = machineLabel(reply.environmentId)
    let unnamed = label == reply.environmentId
    if unnamed, !matches(machineIdShape, label) { return text }
    let machine = unnamed ? "another machine" : label
    return "Regarding \(title) on \(machine):\n\n\(reply.words)"
  }

  /// The server's one-line wrapper around a worker follow-up, current form or the
  /// one before message IDs; nil when the text has neither.
  public static func stripWorkerFollowUp(_ text: String, sourceThreadId: String, messageId: String) -> String? {
    let tail = ". Review that thread and decide whether to reuse it or route elsewhere.\n\n"
    for prefix in [
      "User follow-up from selected worker \(sourceThreadId), message \(messageId)\(tail)",
      "User follow-up from selected worker \(sourceThreadId)\(tail)",
    ] where text.hasPrefix(prefix) {
      return String(text.dropFirst(prefix.count))
    }
    return nil
  }

  /// The text a user row shows. Only the person's own messages are rewritten:
  /// one the assistant routed or a coordinator forwarded shows the person's
  /// words, and a reply from another machine shows its thread's title and
  /// machine name instead of their IDs.
  public static func text(_ text: String, messageId: String, createdBy: ActorKind, senderThreadId: String?, machineLabel: ((String) -> String)?) -> String {
    guard createdBy == .user else { return text }
    if let sender = senderThreadId, messageId.hasPrefix(coordinatorSendPrefix) {
      if let routed = parseRoutedMessage(text), routed.threadId == sender { return routed.words }
      if !messageId.dropFirst(coordinatorSendPrefix.count).trimmingCharacters(in: .whitespaces).isEmpty,
         let words = stripWorkerFollowUp(text, sourceThreadId: sender, messageId: messageId) {
        return words
      }
    }
    return machineLabel.map { routedThreadReplyDisplayText(text, machineLabel: $0) } ?? text
  }

  // MARK: - Matching

  private static func match(_ regex: NSRegularExpression, in text: String) -> (captures: [String?], rest: String)? {
    let ns = text as NSString
    guard let result = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let captures = (1..<result.numberOfRanges).map { index -> String? in
      let range = result.range(at: index)
      return range.location == NSNotFound ? nil : ns.substring(with: range)
    }
    return (captures, ns.substring(from: result.range.upperBound))
  }

  private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
  }
}
