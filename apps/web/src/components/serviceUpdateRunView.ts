import type {
  ServiceUpdateBlocker,
  StudioServiceUpdateRun,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

/**
 * What every window shows for an Update now run (updates/run.json, 0988).
 * The windows only follow the run: nothing here starts a timer that ends it,
 * and no button is offered until the run is terminal.
 */

/** The run going on, or null when there is none or it ended. */
export function liveServiceUpdateRun(
  state: StudioServiceUpdateState | null | undefined,
): StudioServiceUpdateRun | null {
  const run = state?.run ?? null;
  return run !== null && !run.terminal ? run : null;
}

/** "m:ss", or "h:mm:ss" past an hour. */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The threads whose open questions or approvals the blockers count, quoted:
 * three by name, then "and N other threads", counting threads (not requests).
 * A title two threads share is named once and the other counted. Null when
 * none has one.
 */
export function nameQuestionThreads(blockers: ReadonlyArray<ServiceUpdateBlocker>): string | null {
  const threads = new Set<string>();
  const titles: string[] = [];
  let others = 0;
  for (const [index, blocker] of blockers.entries()) {
    if (blocker.kind !== "request" || blocker.count <= 0) continue;
    const title = blocker.threadTitle?.trim();
    const thread = blocker.threadId ?? (title ? `title:${title}` : `blocker:${index}`);
    if (threads.has(thread)) continue;
    threads.add(thread);
    if (title && !titles.includes(title)) titles.push(title);
    else others += 1;
  }
  if (threads.size === 0) return null;
  const named = titles.slice(0, 3).map((title) => `"${title}"`);
  const more = titles.length - named.length + others;
  const list = more > 0 ? [...named, plural(more, "other thread", "other threads")] : named;
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * Names the threads whose open questions or approvals keep the install
 * waiting, for the toast and the sidebar. Null when none does.
 */
export function describeQuestionWait(blockers: ReadonlyArray<ServiceUpdateBlocker>): string | null {
  const threads = nameQuestionThreads(blockers);
  return threads === null ? null : `Waiting for answers in ${threads}.`;
}

/**
 * How many of the `request` blockers wait on the person, as questions and as
 * approvals. A service that sends no split (older) counts every request as a
 * question; a request that is neither (a tool call the app answers) is left out.
 */
export function countPersonRequests(blockers: ReadonlyArray<ServiceUpdateBlocker>): {
  readonly questions: number;
  readonly approvals: number;
  /** Requests that are neither. */
  readonly other: number;
} {
  let questions = 0;
  let approvals = 0;
  let other = 0;
  for (const blocker of blockers) {
    if (blocker.kind !== "request" || blocker.count <= 0) continue;
    if (blocker.questions === undefined && blocker.approvals === undefined) {
      questions += blocker.count;
      continue;
    }
    questions += blocker.questions ?? 0;
    approvals += blocker.approvals ?? 0;
    other += Math.max(0, blocker.count - (blocker.questions ?? 0) - (blocker.approvals ?? 0));
  }
  return { questions, approvals, other };
}

/** The `request` blockers with a question or an approval: a thread that holds only other requests is not named. */
export function personRequestBlockers(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
): ReadonlyArray<ServiceUpdateBlocker> {
  return blockers.filter(
    (blocker) =>
      blocker.kind === "request" &&
      blocker.count > 0 &&
      ((blocker.questions === undefined && blocker.approvals === undefined) ||
        (blocker.questions ?? 0) + (blocker.approvals ?? 0) > 0),
  );
}

/** "2 questions and 1 approval", or null for none. */
export function describePersonRequests(counts: {
  readonly questions: number;
  readonly approvals: number;
}): string | null {
  const parts = [
    counts.questions > 0 ? plural(counts.questions, "question", "questions") : null,
    counts.approvals > 0 ? plural(counts.approvals, "approval", "approvals") : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" and ");
}

/**
 * What an automatic install waiting on unanswered questions says (0991):
 * it never closes them, so it says how many it waits for and where, beside
 * Update now. Null when no question or approval holds it.
 */
export function describeAutomaticInstallWait(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
): string | null {
  const waiting = personRequestBlockers(blockers);
  const threads = nameQuestionThreads(waiting);
  const what = describePersonRequests(countPersonRequests(waiting));
  if (threads === null || what === null) return null;
  return `Update ready: waiting for ${what} you haven't answered, in ${threads}.`;
}

/** The helper's phase name (`checkBeforeRestart`) as words (`check before restart`). */
export function humanizeStep(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase()
    .trim();
}

export const RUN_NO_PROGRESS_LINE = "No progress for 2 min, still installing.";
export const RUN_SERVICE_BACK_LINE = "Service is back, finishing checks.";
export const RUN_ROLLBACK_LINE = "The install did not pass its checks; restoring.";
export const RUN_NOT_APPLIED_LINE =
  "The install did not apply; SpecWithCode stays on the running version.";

/** The helper's rollback phase (install_progress.py ROLLBACK). */
const ROLLBACK_STEP = "rollback";

export interface ServiceUpdateRunViewModel {
  readonly tone: "loading" | "success" | "error" | "info";
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  /** Amber: no sign of life for over 2 minutes. Never comes with a button. */
  readonly warning: string | null;
  /** Only once the run is terminal. */
  readonly action: { readonly kind: "retry" | "restart-app"; readonly label: string } | null;
  /** The sidebar button's text while the run is live. */
  readonly label: string;
}

export function describeServiceUpdateRun(
  run: StudioServiceUpdateRun,
  nowMs: number,
  blockers: ReadonlyArray<ServiceUpdateBlocker> = [],
): ServiceUpdateRunViewModel {
  const version = run.targetVersion;
  const started = Date.parse(run.startedAt);
  const elapsed = Number.isFinite(started) ? formatRunDuration(nowMs - started) : null;
  const live = (
    title: string,
    label: string,
    lines: ReadonlyArray<string | null> = [],
  ): ServiceUpdateRunViewModel => ({
    tone: "loading",
    title,
    lines: lines.filter((line): line is string => line !== null),
    warning: run.noProgress ? RUN_NO_PROGRESS_LINE : null,
    action: null,
    label,
  });

  if (run.terminal) {
    // From the press to done: a run with an app half ends when the app did.
    const endedAt =
      run.appTargetVersion !== null && run.app?.finishedAt ? run.app.finishedAt : run.endedAt;
    const ended = endedAt ? Date.parse(endedAt) : Number.NaN;
    const took =
      Number.isFinite(started) && Number.isFinite(ended)
        ? ` in ${formatRunDuration(ended - started)}`
        : "";
    const end = (
      tone: ServiceUpdateRunViewModel["tone"],
      title: string,
      lines: ReadonlyArray<string | null>,
      action: ServiceUpdateRunViewModel["action"],
    ): ServiceUpdateRunViewModel => ({
      tone,
      title,
      lines: lines.filter((line): line is string => line !== null),
      warning: null,
      action,
      label: title,
    });
    switch (run.outcome) {
      case "updated":
        return end("success", `Updated to ${run.appTargetVersion ?? version}${took}`, [], null);
      case "cancelled":
        return end(
          "info",
          "Update cancelled",
          [run.message === "Update cancelled" ? null : run.message],
          null,
        );
      case "expired":
        return end("error", "The update stopped", [run.message], {
          kind: "retry",
          label: "Try again",
        });
      default:
        if (run.app?.phase === "failed") {
          return end(
            "error",
            `The service updated to ${version}, but the app did not`,
            [run.app.message ?? "App update did not apply."],
            { kind: "restart-app", label: "Restart now" },
          );
        }
        return end("error", "The update did not finish", [run.message], {
          kind: "retry",
          label: "Try again",
        });
    }
  }

  switch (run.phase) {
    case "preparing":
    case "requested":
      return live(`Starting the update to ${version}`, "Starting update…", [
        elapsed ? `${elapsed} elapsed.` : null,
      ]);
    case "downloading":
      return live(`Downloading SpecWithCode ${version}`, "Downloading update…");
    case "waiting":
      return live(`Waiting to install SpecWithCode ${version}`, "Waiting to update…", [
        describeQuestionWait(blockers) ?? "Waiting for running work to stop.",
      ]);
    case "installing": {
      const step = run.step;
      if (step === null) {
        return live(`Installing SpecWithCode ${version}`, "Installing update…", [
          elapsed ? `${elapsed} elapsed.` : null,
        ]);
      }
      // A failed apply puts the running release back (or has ended without
      // it): never "installing" or "service is back" over that.
      const result = step.result ?? null;
      if (step.label === ROLLBACK_STEP || (result !== null && result !== "verified")) {
        const restoring = result === null;
        return live(
          restoring
            ? "Putting SpecWithCode back to the running version"
            : `SpecWithCode ${version} was not installed`,
          restoring ? "Restoring…" : "Finishing…",
          [
            restoring ? RUN_ROLLBACK_LINE : RUN_NOT_APPLIED_LINE,
            elapsed ? `${elapsed} elapsed.` : null,
          ],
        );
      }
      const expected =
        step.expectedMs !== null ? `, about ${formatRunDuration(step.expectedMs)} expected` : "";
      // The expected time is the helper's apply only, so it is measured on the
      // helper's clock, not from the press (stopping work, waiting, download).
      const helperStarted = step.startedAt ? Date.parse(step.startedAt) : Number.NaN;
      const installing = Number.isFinite(helperStarted)
        ? formatRunDuration(nowMs - helperStarted)
        : elapsed;
      return live(`Installing SpecWithCode ${version}`, `Installing ${step.i}/${step.n}…`, [
        step.serviceBack ? RUN_SERVICE_BACK_LINE : null,
        `Step ${step.i} of ${step.n}: ${humanizeStep(step.label)}.`,
        installing ? `${installing} elapsed${expected}.` : null,
      ]);
    }
    default: {
      // Verified, with the app still to install.
      const appVersion = run.appTargetVersion ?? version;
      if (run.app?.phase === "relaunching") {
        return live(`Restarting SpecWithCode into ${appVersion}`, "Restarting…", [
          `The service runs ${version}.`,
        ]);
      }
      return live(`Installing the SpecWithCode app ${appVersion}`, "Installing app update…", [
        `The service runs ${version}.`,
        run.app?.message ?? null,
      ]);
    }
  }
}
