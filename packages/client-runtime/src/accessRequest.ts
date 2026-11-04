import type {
  AccessRequestAnswerInput,
  AccessRequestScope,
  AccessRequestSubject,
  OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";

export type AccessRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "access_request" }
>;

/** The scope choices, in the order the card offers them. */
export const ACCESS_REQUEST_SCOPES: ReadonlyArray<{
  readonly scope: AccessRequestScope;
  readonly label: string;
}> = [
  { scope: "thread", label: "This thread" },
  { scope: "machine", label: "Always on this machine" },
];

/** Under the buttons: the one promise the card makes about what Allow does. */
export const ACCESS_REQUEST_FOOTNOTE =
  "You can take back an Always grant in Settings → Integrations.";

/** What an access request card shows: the choice while pending, otherwise a one-line outcome. */
export type AccessRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "allowed" | "denied" | "ended";
      readonly label: string;
    };

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function accessRequestDisplay(
  item: Pick<AccessRequestItem, "accessStatus" | "accessScope">,
  visibility: "local" | "inherited" | "synthetic",
): AccessRequestDisplay {
  switch (item.accessStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: "Waiting for an answer in the original thread" };
    case "allowed":
      return {
        kind: "answered",
        outcome: "allowed",
        label:
          item.accessScope === "machine" ? "Allowed on this machine" : "Allowed for this session",
      };
    case "denied":
      return { kind: "answered", outcome: "denied", label: "Denied" };
    case "cancelled":
      return { kind: "answered", outcome: "ended", label: "Request ended" };
  }
}

/** The glyph a client draws when a subject has no icon of its own. */
export type AccessSubjectGlyph = "app" | "phone" | "tablet" | "android" | "machine" | "folder";

export function accessSubjectGlyph(subject: AccessRequestSubject): AccessSubjectGlyph {
  switch (subject.kind) {
    case "app":
      return "app";
    case "device":
      if (subject.platform === "android") return "android";
      return /\bipad\b/i.test(subject.label) ? "tablet" : "phone";
    case "machine":
      return "machine";
    case "folder":
      return "folder";
  }
}

/** A `data:` URL for a subject's own icon, or null to draw its glyph. */
export function accessSubjectIconUrl(subject: AccessRequestSubject): string | null {
  return subject.icon === undefined
    ? null
    : `data:${subject.icon.mimeType};base64,${subject.icon.data}`;
}

export function accessRequestAnswerInput(
  item: Pick<AccessRequestItem, "id" | "threadId">,
  answer:
    | { readonly type: "allow"; readonly scope: AccessRequestScope }
    | { readonly type: "deny" },
): AccessRequestAnswerInput {
  return {
    threadId: item.threadId,
    turnItemId: item.id,
    answer: answer.type === "deny" ? { type: "deny" } : { type: "allow", scope: answer.scope },
  };
}

/** Failures whose message is written for the user. */
const USER_FACING_FAILURE_TAGS = new Set(["AccessRequestError", "EnvironmentAuthorizationError"]);

export function accessRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}

type SubjectLike = Pick<AccessRequestSubject, "kind" | "label">;

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** "Claude wants to use SpecWithCode", "Codex wants to control iPhone 17 Pro". */
export function accessRequestHeadline(
  agentLabel: string | null | undefined,
  subjects: ReadonlyArray<SubjectLike>,
): string {
  const agent = agentLabel?.trim() || "The agent";
  const used = subjects.filter((subject) => subject.kind !== "device").map((s) => s.label);
  const controlled = subjects.filter((subject) => subject.kind === "device").map((s) => s.label);
  const parts = [
    ...(used.length > 0 ? [`use ${joinNames(used)}`] : []),
    ...(controlled.length > 0 ? [`control ${joinNames(controlled)}`] : []),
  ];
  return `${agent} wants to ${parts.join(" and ") || "use something on your computer"}`;
}

/** The scope tag on each subject chip: what the agent may do with it. */
export function accessSubjectTag(_subject: SubjectLike): string {
  return "All";
}

/** The one plain line under the chips, saying what Allow lets the agent do. */
export function accessRequestNote(subjects: ReadonlyArray<SubjectLike>): string {
  const apps = subjects.some((subject) => subject.kind === "app");
  const devices = subjects.some((subject) => subject.kind === "device");
  if (apps && devices) {
    return "The agent can see your screen, click and type in these apps, and drive the device.";
  }
  if (devices) return "The agent can see the device's screen, tap, type and install apps on it.";
  if (subjects.some((subject) => subject.kind === "folder")) {
    return "The agent can read and change files in this folder.";
  }
  if (subjects.some((subject) => subject.kind === "machine")) {
    return "The agent can run work on that machine.";
  }
  return "The agent can see your screen and click and type in these apps while it works.";
}

/** A waiting thread's subtitle in the coordinator and thread lists. */
export function accessRequestWaitingSubtitle(subjects: ReadonlyArray<SubjectLike>): string {
  const kinds = new Set(subjects.map((subject) => subject.kind));
  if (kinds.size === 1 && kinds.has("device")) {
    return subjects.length === 1 ? "Asking to control a device" : "Asking to control devices";
  }
  if (kinds.size === 1 && kinds.has("folder")) return "Asking to use a folder";
  if (kinds.size === 1 && kinds.has("machine")) return "Asking to work on another machine";
  return "Asking to use apps on your computer";
}

/**
 * The coordinator's line for a thread waiting on a card, after the thread
 * link: "is waiting for you to allow access to M4, so it can find …".
 */
export function accessRequestWaitingSentence(machineLabel: string, reason: string): string {
  const purpose = reason
    .trim()
    .replace(/[.!]+$/u, "")
    .replace(/^(?:to|in order to)\s+/iu, "");
  const lowered = purpose.length > 0 ? purpose[0]!.toLowerCase() + purpose.slice(1) : "";
  return lowered.length > 0
    ? `is waiting for you to allow access to ${machineLabel}, so it can ${lowered}.`
    : `is waiting for you to allow access to ${machineLabel}.`;
}
