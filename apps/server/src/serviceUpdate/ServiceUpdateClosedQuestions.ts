/**
 * The questions and approvals a forced "Update now" closes, kept so they are
 * asked again once the update is over (owner decision D-03, increment 0991).
 *
 * The drain records each one (`record`) before it stops a turn, dismisses a
 * question or cancels a request, so nothing it closes goes unrecorded even
 * when the interrupt itself cancels the request. `ServiceUpdateReopenQuestions`
 * reopens each recorded thread once the service is no longer held: after the
 * restart that installs the update (once the helper's install gate has opened,
 * so a rollback never discards the reopen), and in the same process when the
 * update is cancelled, refused or expires. An automatic install closes no
 * question; its stale-wait sweep releases approvals only, records each one
 * first (`reopenAfterRestart`), and they are asked again once that automatic
 * install is no longer under way (installed, failed, cancelled), not while it
 * still waits, even across a restart that was not the install.
 *
 * A record that cannot be read or written (a read error, a full disk) fails
 * `record`, and the drain then closes nothing more: a question is never closed
 * unrecorded, and a file that cannot be read is never overwritten. Entries
 * this release cannot decode (a newer release wrote them) are written back as
 * they were; a file that is no record at all is set aside, not overwritten.
 *
 * Where the record lives: `updates/closed-questions.json` under the service's
 * base directory, beside the update agent's `state.json` and the hold's
 * `hold.json`, not a table in the state database. A rollback restores the
 * database snapshot (statev2.sqlite and settings.json) and leaves this folder
 * alone; the file needs no migration, so a service that does not know it (an
 * older release a rollback put back) simply ignores it and the next release
 * that knows it reopens what is still unreopened when it starts. Each entry is
 * marked `reopenedAt` once it is reopened; the writes that reopen it use ids
 * derived from the closed request, so a crash between the reopen and the mark
 * repeats nothing. Reopened entries are kept for `KEEP_REOPENED_MS`, so a
 * restart continuation that runs later still finds what its thread was asked.
 *
 * @module ServiceUpdateClosedQuestions
 */
import {
  OrchestrationV2UserInputQuestion,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/** Request kinds that wait on the person and are reopened as a question. */
export const QUESTION_REQUEST_KINDS: ReadonlySet<string> = new Set(["user_input", "auth_refresh"]);
/** Request kinds that ask the person to approve a step. */
export const APPROVAL_KINDS: ReadonlySet<string> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
  "mcp-elicitation",
]);
/** Requests the app answers itself (a dynamic tool call) are neither, and are not recorded. */
export const isPersonRequestKind = (kind: string) =>
  QUESTION_REQUEST_KINDS.has(kind) || APPROVAL_KINDS.has(kind);

/** How long a reopened entry stays in the file. */
export const KEEP_REOPENED_MS = 7 * 24 * 60 * 60_000;
const MAX_TEXT_LENGTH = 600;

export const ClosedQuestion = Schema.Struct({
  requestId: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  /** The runtime request's kind: `user_input`, `auth_refresh` or an approval kind. */
  kind: Schema.String,
  /** What the person was asked, one line per question, as the note quotes it. */
  text: Schema.String,
  /** A question's own cards, asked again as they were. */
  questions: Schema.optional(Schema.Array(OrchestrationV2UserInputQuestion)),
  askedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.String,
  reopenedAt: Schema.NullOr(Schema.String),
  /**
   * The process that recorded it (`bootId`). One reopened in that same process
   * was never restarted, so no restart continuation will ask it again.
   */
  closedIn: Schema.optional(Schema.String),
  /** Closed by an automatic install's stale-wait sweep: reopened only after a restart. */
  reopenAfterRestart: Schema.optional(Schema.Boolean),
  /** How it was asked again; a restart continuation leaves out one asked as a card. */
  reopenedBy: Schema.optional(Schema.Literals(["card", "agent"])),
});
export type ClosedQuestion = typeof ClosedQuestion.Type;

const decodeEntry = Schema.decodeUnknownOption(ClosedQuestion);
const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(JsonText);
const encodeJson = Schema.encodeEffect(JsonText);

/**
 * A record file as read: the entries this release understands, the ones it
 * does not (`kept`, written back as they were, so a rollback to an older
 * release never drops what a newer one recorded) and the file's version.
 */
export interface ClosedQuestionsFile {
  readonly version: number;
  readonly entries: ReadonlyArray<ClosedQuestion>;
  readonly kept: ReadonlyArray<unknown>;
}

/** A record file's contents, each entry decoded alone; None when it is not a record at all. */
export function parseClosedQuestionsFile(text: string): Option.Option<ClosedQuestionsFile> {
  const parsed = decodeJson(text);
  if (Option.isNone(parsed)) return Option.none();
  const value = parsed.value;
  if (typeof value !== "object" || value === null) return Option.none();
  const { version, entries } = value as { readonly version?: unknown; readonly entries?: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || !Array.isArray(entries))
    return Option.none();
  const decoded: Array<ClosedQuestion> = [];
  const kept: Array<unknown> = [];
  for (const entry of entries as ReadonlyArray<unknown>) {
    const one = decodeEntry(entry);
    if (Option.isSome(one)) decoded.push(one.value);
    else kept.push(entry);
  }
  return Option.some({ version, entries: decoded, kept });
}

/** The entries in a record file; an unreadable file holds none. */
export function parseClosedQuestions(text: string): ReadonlyArray<ClosedQuestion> {
  return Option.match(parseClosedQuestionsFile(text), {
    onNone: () => [],
    onSome: (file) => file.entries,
  });
}

const compact = (value: string) => {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
};

/** Whether `kind` is reopened as an approval rather than as the question it was. */
export const isApprovalKind = (kind: string) => !QUESTION_REQUEST_KINDS.has(kind);

/**
 * What a pending request asked, from its card: the questions of a question,
 * the prompt of an approval, or a plain description when the card is gone.
 */
export function describeClosedRequest(
  request: Pick<OrchestrationV2RuntimeRequest, "kind">,
  item: OrchestrationV2TurnItem | undefined,
): { readonly text: string; readonly questions?: ReadonlyArray<OrchestrationV2UserInputQuestion> } {
  if (item?.type === "user_input_request" && item.questions.length > 0) {
    return {
      text: item.questions.map((question) => compact(question.question)).join("\n"),
      questions: item.questions,
    };
  }
  if (item?.type === "approval_request") {
    const prompt = item.prompt ?? item.title ?? null;
    if (prompt !== null && prompt.trim().length > 0) return { text: compact(prompt) };
  }
  if (request.kind === "auth_refresh") return { text: "Sign in again so the agent can go on." };
  if (request.kind === "user_input") return { text: "A question for you." };
  return { text: `Approve a ${request.kind} step.` };
}

/**
 * Whether the update closed `request`: the drain cancels a request, and
 * dismisses a question asked as a message (resolved with `cancel` and no
 * answer). One answered, or still pending, was not closed.
 */
export function wasClosed(
  request: Pick<OrchestrationV2RuntimeRequest, "status" | "decision" | "answers">,
): boolean {
  if (request.status === "cancelled" || request.status === "expired") return true;
  return request.status === "resolved" && request.decision === "cancel" && !request.answers;
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** How a thread's closed question comes back: as a card, or from the agent that continues. */
export type ReopenedBy = "card" | "agent";

/** The note on the thread that quotes what the update closed. */
export function closedQuestionNote(entry: ClosedQuestion, by: ReopenedBy): string {
  const approval = isApprovalKind(entry.kind);
  const what = approval
    ? "this approval request while it waited for you"
    : "this question while it waited for your answer";
  const then =
    by === "agent"
      ? approval
        ? "The agent continues and asks for it again when it needs it."
        : "The agent continues and asks it again."
      : "It is asked again below.";
  return `The SpecWithCode update closed ${what}:\n\n${quote(entry.text)}\n\n${then}`;
}

/**
 * The question a closed request is asked again as. A question keeps its
 * cards; an approval, whose agent process is gone, becomes a question whose
 * answer goes to the agent as a message.
 */
export function reopenedQuestions(
  entry: ClosedQuestion,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  if (!isApprovalKind(entry.kind) && entry.questions !== undefined && entry.questions.length > 0)
    return entry.questions;
  if (entry.kind === "auth_refresh") {
    return [
      {
        id: "sign-in",
        header: "Sign in",
        question: `The update closed a sign-in request: ${entry.text} Tell the agent when you have signed in.`,
        options: [{ label: "Signed in", description: "The agent goes on." }],
        allowCustomAnswer: true,
      },
    ];
  }
  if (!isApprovalKind(entry.kind)) {
    return [
      {
        id: "question",
        header: "Question",
        question: entry.text,
        options: [],
        allowCustomAnswer: true,
      },
    ];
  }
  return [
    {
      id: "approval",
      header: "Approval",
      question: `The update closed this approval request: ${entry.text} Should the agent go ahead?`,
      options: [
        { label: "Go ahead", description: "The agent runs that step again." },
        { label: "Don't", description: "The agent leaves that step out." },
      ],
      allowCustomAnswer: true,
    },
  ];
}

/** The request id of a card that asks a closed approval again. */
export const REOPENED_APPROVAL_PREFIX = "update-reopen-approval:";
export const REOPENED_QUESTION_PREFIX = "update-reopen:";
/** Every reopen prefix in front of a request id (older releases stacked one per update). */
const REOPEN_PREFIXES = /^(?:update-reopen(?:-approval)?:)+/;

/** Whether a pending request is a card asking a closed approval again (it waits like one). */
export const isReopenedApprovalRequestId = (requestId: string) =>
  requestId.startsWith(REOPENED_APPROVAL_PREFIX);

/** Whether `requestId` is a card that asks a closed request again. */
export const isReopenCardRequestId = (requestId: string) => REOPEN_PREFIXES.test(requestId);

/**
 * The request a card asks again: `requestId` without its reopen prefixes, so
 * one stacked by older releases names the same request as a fresh one.
 */
export function reopenFamilyRequestId(requestId: string): string {
  return requestId.replace(REOPEN_PREFIXES, "");
}

/**
 * The request id of the card that asks `entry` again, derived from it so a
 * second reopen records nothing new. It carries one prefix however often
 * updates closed it: a card that asked a closed request again and was closed
 * in turn is asked again under its own id, not a longer one. A closed
 * approval, or a card that asked one again, keeps the approval prefix.
 */
export function reopenCardRequestId(entry: Pick<ClosedQuestion, "kind" | "requestId">): string {
  const prefixes = REOPEN_PREFIXES.exec(entry.requestId)?.[0] ?? "";
  const approval = isApprovalKind(entry.kind) || prefixes.includes(REOPENED_APPROVAL_PREFIX);
  return `${approval ? REOPENED_APPROVAL_PREFIX : REOPENED_QUESTION_PREFIX}${entry.requestId.slice(prefixes.length)}`;
}

/**
 * What a restart continuation tells the agent before "Continue where you left
 * off.": what the update closed, and to ask it again. Null when it closed nothing.
 */
export function closedQuestionsPrompt(entries: ReadonlyArray<ClosedQuestion>): string | null {
  // One question closed twice (asked again, then closed by a later drain) is said once.
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = `${isApprovalKind(entry.kind)}\u0000${entry.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return null;
  const questions = unique.filter((entry) => !isApprovalKind(entry.kind));
  const approvals = unique.filter((entry) => isApprovalKind(entry.kind));
  const parts: Array<string> = [];
  if (questions.length > 0) {
    parts.push(
      `While you waited for an answer, the SpecWithCode update closed your ${questions.length === 1 ? "question" : "questions"} before the person answered:\n\n${questions.map((entry) => quote(entry.text)).join("\n\n")}\n\nAsk ${questions.length === 1 ? "it" : "them"} again the way you asked before, and wait for the answer.`,
    );
  }
  if (approvals.length > 0) {
    parts.push(
      `The update also closed ${approvals.length === 1 ? "your request" : "your requests"} for approval before the person answered:\n\n${approvals.map((entry) => quote(entry.text)).join("\n\n")}\n\nIf you still need ${approvals.length === 1 ? "that step" : "those steps"}, run ${approvals.length === 1 ? "it" : "them"} again so the person can approve ${approvals.length === 1 ? "it" : "them"}.`,
    );
  }
  return parts.join("\n\n");
}

/** Entries kept after `nowMs`: every unreopened one, and reopened ones still recent. */
export function pruneClosedQuestions(
  entries: ReadonlyArray<ClosedQuestion>,
  nowMs: number,
): ReadonlyArray<ClosedQuestion> {
  return entries.filter((entry) => {
    if (entry.reopenedAt === null) return true;
    const at = Date.parse(entry.reopenedAt);
    return !Number.isFinite(at) || nowMs - at < KEEP_REOPENED_MS;
  });
}

/** One entry asked again (`by`), or given up without asking (`by` null). */
export interface ReopenedEntry {
  readonly requestId: string;
  readonly by: ReopenedBy | null;
}

export interface ServiceUpdateClosedQuestionsShape {
  /** This process, as entries it records name it (`closedIn`). */
  readonly bootId: string;
  /**
   * Adds entries, keeping one per request (the first record wins while it is
   * still to be reopened, though a later record's `reopenAfterRestart` and
   * `closedIn` replace its own). A request recorded again after its entry was
   * reopened was never closed (it is still open), so the new record replaces
   * the old one. Written before anything closes; false when the record could
   * not be read or written, and then nothing may be closed.
   */
  readonly record: (entries: ReadonlyArray<ClosedQuestion>) => Effect.Effect<boolean>;
  /** Entries not reopened yet. */
  readonly pending: Effect.Effect<ReadonlyArray<ClosedQuestion>>;
  /** Every entry recorded for one run of a thread, reopened or not. */
  readonly forRun: (
    threadId: string,
    runId: string,
  ) => Effect.Effect<ReadonlyArray<ClosedQuestion>>;
  /** Marks entries reopened; false when the mark could not be written. */
  readonly markReopened: (reopened: ReadonlyArray<ReopenedEntry>) => Effect.Effect<boolean>;
  /**
   * Runs a drain: nothing is reopened while one is under way, and a reopen
   * pass already under way ends (after the entry it is on) before it starts.
   */
  readonly draining: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly isDraining: Effect.Effect<boolean>;
  /** Runs a reopen pass; a drain that starts waits for it to end. */
  readonly reopening: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class ServiceUpdateClosedQuestions extends Context.Service<
  ServiceUpdateClosedQuestions,
  ServiceUpdateClosedQuestionsShape
>()("specweave-studio/serviceUpdate/ServiceUpdateClosedQuestions") {}

const encodeEntries = Schema.encodeEffect(Schema.Array(ClosedQuestion));

/** A record file that is there but could not be read (not a missing one). */
class RecordUnreadable extends Data.TaggedError("RecordUnreadable")<{
  readonly cause: unknown;
}> {}

/** What `record` keeps when a request is recorded again. */
export function mergeRecorded(
  entries: ReadonlyArray<ClosedQuestion>,
  added: ReadonlyArray<ClosedQuestion>,
  bootId: string,
): ReadonlyArray<ClosedQuestion> {
  const next = [...entries];
  const at = new Map(next.map((entry, index) => [entry.requestId, index]));
  let changed = false;
  for (const entry of added) {
    const stamped = entry.closedIn === undefined ? { ...entry, closedIn: bootId } : entry;
    const index = at.get(entry.requestId);
    if (index === undefined) {
      at.set(entry.requestId, next.length);
      next.push(stamped);
      changed = true;
      continue;
    }
    const existing = next[index]!;
    // Reopened, yet still open now: that close never happened, this one counts.
    if (existing.reopenedAt !== null) {
      next[index] = stamped;
      changed = true;
      continue;
    }
    // A card asking a closed request again keeps its id across updates, and
    // only a pending request is recorded: the card was put back (its mark may
    // not have been written) and this is a new close. The reopen's command ids
    // carry `closedAt`, so it must be this close's, or the put-back replays.
    if (
      isReopenCardRequestId(entry.requestId) &&
      Date.parse(stamped.closedAt) > Date.parse(existing.closedAt)
    ) {
      next[index] = stamped;
      changed = true;
      continue;
    }
    // Still to reopen: the latest close says when (a forced drain's record
    // no longer waits for the restart an automatic install's sweep waited for).
    const afterRestart = stamped.reopenAfterRestart === true;
    if ((existing.reopenAfterRestart === true) === afterRestart) continue;
    const { reopenAfterRestart: _dropped, ...rest } = existing;
    next[index] = {
      ...rest,
      ...(stamped.closedIn === undefined ? {} : { closedIn: stamped.closedIn }),
      ...(afterRestart ? { reopenAfterRestart: true } : {}),
    };
    changed = true;
  }
  return changed ? next : entries;
}

/** Stores made in this process, so each one's `bootId` is its own. */
let stores = 0;

export const makeWithPath = (recordPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const passes = yield* Semaphore.make(1);
    const drains = yield* Ref.make(0);
    stores += 1;
    const bootId = `${process.pid}:${DateTime.toEpochMillis(yield* DateTime.now)}:${stores}:${yield* Random.nextIntBetween(0, 1_000_000_000)}`;

    const EMPTY: ClosedQuestionsFile = { version: 1, entries: [], kept: [] };
    /**
     * The file as it is. A missing file holds nothing; one that cannot be read
     * (a read error) fails, so nothing overwrites what it holds; one that is
     * no record at all (`unreadable`) is set aside by the next write.
     */
    const readFile = fileSystem.readFileString(recordPath).pipe(
      Effect.map((text) =>
        Option.match(parseClosedQuestionsFile(text), {
          onNone: () => ({ file: EMPTY, unreadable: true }),
          onSome: (file) => ({ file, unreadable: false }),
        }),
      ),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed({ file: EMPTY, unreadable: false }),
      ),
      Effect.mapError((cause) => new RecordUnreadable({ cause })),
    );
    /** For reads alone: what cannot be read holds nothing. */
    const read = readFile.pipe(
      Effect.map(({ file }) => file.entries),
      Effect.orElseSucceed((): ReadonlyArray<ClosedQuestion> => []),
    );
    const write = (file: ClosedQuestionsFile, entries: ReadonlyArray<ClosedQuestion>) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(recordPath), { recursive: true });
        const temporary = `${recordPath}.${process.pid}.tmp`;
        const encoded = yield* encodeEntries(entries);
        const content = yield* encodeJson({
          version: file.version,
          entries: [...encoded, ...file.kept],
        });
        yield* fileSystem.writeFileString(temporary, `${content}\n`, { mode: 0o600 });
        yield* fileSystem.rename(temporary, recordPath);
      });
    /** One read-change-write at a time; a failed read or write is logged, changes nothing and answers false. */
    const update = (
      label: string,
      change: (
        entries: ReadonlyArray<ClosedQuestion>,
        nowMs: number,
      ) => ReadonlyArray<ClosedQuestion>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const { file, unreadable } = yield* readFile;
          const next = change(file.entries, now);
          // Nothing new: the file stays as it is.
          if (next === file.entries) return true;
          if (unreadable) {
            // Kept aside, not overwritten: what it held may still be read by hand.
            const aside = `${recordPath}.unreadable-${now}`;
            yield* fileSystem.rename(recordPath, aside);
            yield* Effect.logWarning("service-update.closed-questions.unreadable-set-aside", {
              path: aside,
            });
          }
          yield* write(file, pruneClosedQuestions(next, now));
          return true;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`service-update.closed-questions.${label}-failed`, { cause }).pipe(
              Effect.as(false),
            ),
          ),
        ),
      );

    const record: ServiceUpdateClosedQuestionsShape["record"] = (added) =>
      added.length === 0
        ? Effect.succeed(true)
        : update("record", (entries) => mergeRecorded(entries, added, bootId)).pipe(
            Effect.tap((written) =>
              written
                ? Effect.logWarning("service-update.closed-questions.recorded", {
                    requests: added.length,
                    threads: new Set(added.map((entry) => entry.threadId)).size,
                  })
                : Effect.void,
            ),
          );

    const markReopened: ServiceUpdateClosedQuestionsShape["markReopened"] = (reopened) =>
      reopened.length === 0
        ? Effect.succeed(true)
        : update("mark", (entries, nowMs) => {
            const by = new Map(reopened.map((entry) => [entry.requestId, entry.by]));
            const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
            let changed = false;
            const next = entries.map((entry) => {
              if (!by.has(entry.requestId) || entry.reopenedAt !== null) return entry;
              changed = true;
              const how = by.get(entry.requestId) ?? null;
              return { ...entry, reopenedAt: at, ...(how === null ? {} : { reopenedBy: how }) };
            });
            return changed ? next : entries;
          });

    return ServiceUpdateClosedQuestions.of({
      bootId,
      record,
      pending: Effect.map(read, (entries) => entries.filter((entry) => entry.reopenedAt === null)),
      forRun: (threadId, runId) =>
        Effect.map(read, (entries) =>
          entries.filter((entry) => entry.threadId === threadId && entry.runId === runId),
        ),
      markReopened,
      draining: (effect) =>
        Effect.acquireUseRelease(
          Ref.update(drains, (count) => count + 1),
          // A pass under way sees the drain and ends; the drain starts after it.
          () => passes.withPermits(1)(Effect.void).pipe(Effect.andThen(effect)),
          () => Ref.update(drains, (count) => count - 1),
        ),
      isDraining: Effect.map(Ref.get(drains), (count) => count > 0),
      reopening: (effect) => passes.withPermits(1)(effect),
    });
  });

export const layer = Layer.effect(
  ServiceUpdateClosedQuestions,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeWithPath(path.join(config.baseDir, "updates", "closed-questions.json"));
  }),
);
