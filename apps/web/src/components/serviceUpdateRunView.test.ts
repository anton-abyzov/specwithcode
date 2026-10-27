import type {
  ServiceUpdateBlocker,
  StudioServiceUpdateRun,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeAutomaticInstallWait,
  describeQuestionWait,
  describeServiceUpdateRun,
  formatRunDuration,
  humanizeStep,
  liveServiceUpdateRun,
  RUN_NO_PROGRESS_LINE,
  RUN_NOT_APPLIED_LINE,
  RUN_ROLLBACK_LINE,
  RUN_SERVICE_BACK_LINE,
} from "./serviceUpdateRunView";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const run = (values: Partial<StudioServiceUpdateRun> = {}): StudioServiceUpdateRun => ({
  runId: "run-1",
  phase: "installing",
  terminal: false,
  targetVersion: "1.0.70",
  appTargetVersion: null,
  startedAt: new Date(T0).toISOString(),
  deadlineAt: new Date(T0 + 30 * 60_000).toISOString(),
  lastSignAt: new Date(T0).toISOString(),
  noProgress: false,
  step: null,
  app: null,
  message: null,
  outcome: null,
  endedAt: null,
  ...values,
});

const question = (threadTitle: string | null, count = 1) =>
  ({
    kind: "request",
    count,
    threadId: threadTitle,
    threadTitle,
    projectId: null,
    projectTitle: null,
  }) as unknown as ServiceUpdateBlocker;

describe("liveServiceUpdateRun", () => {
  it("is the run only while it is not terminal", () => {
    const state = { status: "installing" } as StudioServiceUpdateState;
    expect(liveServiceUpdateRun(null)).toBeNull();
    expect(liveServiceUpdateRun(state)).toBeNull();
    expect(liveServiceUpdateRun({ ...state, run: run() })?.runId).toBe("run-1");
    expect(liveServiceUpdateRun({ ...state, run: run({ terminal: true }) })).toBeNull();
  });
});

describe("describeQuestionWait", () => {
  it("names the threads with open questions, and counts the rest", () => {
    expect(describeQuestionWait([])).toBeNull();
    expect(
      describeQuestionWait([{ ...question("Fix login"), kind: "run" } as ServiceUpdateBlocker]),
    ).toBeNull();
    expect(describeQuestionWait([question("Fix login")])).toBe(
      'Waiting for answers in "Fix login".',
    );
    expect(
      describeQuestionWait([
        question("A"),
        question("B"),
        question("A"),
        question("C"),
        question("D"),
        question(null, 2),
      ]),
      // D, and one untitled thread with two questions: threads are counted.
    ).toBe('Waiting for answers in "A", "B", "C" and 2 other threads.');
  });
});

describe("describeAutomaticInstallWait", () => {
  it("says in a short line how many open questions hold an automatic install", () => {
    expect(describeAutomaticInstallWait([])).toBeNull();
    expect(describeAutomaticInstallWait([question("Fix login")])).toEqual({
      line: "Update waits on 1 question.",
      detail:
        'In "Fix login". The update installs once it is answered or has waited 2 minutes; anything still open is asked again after the restart. Update now installs right away.',
    });
    expect(describeAutomaticInstallWait([question("Fix login", 2), question("Docs")])).toEqual({
      line: "Update waits on 3 questions.",
      detail:
        'In "Fix login" and "Docs". The update installs once they are answered or have waited 2 minutes; anything still open is asked again after the restart. Update now installs right away.',
    });
    // A service that splits them: approvals are named as such, tool calls are not counted.
    expect(
      describeAutomaticInstallWait([
        { ...question("Fix login", 3), questions: 1, approvals: 1 },
        { ...question("Tools"), questions: 0, approvals: 0 },
      ])?.line,
    ).toBe("Update waits on 1 question and 1 approval.");
    expect(
      describeAutomaticInstallWait([{ ...question("Tools"), questions: 0, approvals: 0 }]),
    ).toBeNull();
  });

  it("says when running work pauses for the install, with Install now and Later", () => {
    const nowMs = Date.parse("2026-10-26T14:30:00.000Z");
    const pauseAt = "2026-10-26T14:41:00.000Z";
    const formatTime = (ms: number) => (ms === Date.parse(pauseAt) ? "2:41 PM" : "other");
    expect(describeAutomaticInstallWait([], { pauseAt, nowMs, formatTime })).toEqual({
      line: "Installs at 2:41 PM. Running turns pause then and continue after the update.",
      detail:
        "The update has waited for running work to finish. Then SpecWithCode pauses the running turns, installs and restarts its background service, and the paused turns continue where they left off. Install now does it right away; Later waits another hour.",
      pauseAt,
    });
    // Due already: the agent's next pass pauses the work, minutes away.
    expect(
      describeAutomaticInstallWait([], {
        pauseAt,
        nowMs: Date.parse("2026-10-26T14:45:00.000Z"),
        formatTime,
      })?.line,
    ).toBe("Installs shortly. Running turns pause then and continue after the update.");
    // Questions are the blocker: their wording leads, and the pause time
    // follows with Install now and Later.
    const asked = describeAutomaticInstallWait([question("Fix login")], {
      pauseAt,
      nowMs,
      formatTime,
    });
    expect(asked?.line).toBe("Update waits on 1 question.");
    expect(asked?.pauseLine).toBe(
      "Installs at 2:41 PM. Running turns pause then and continue after the update.",
    );
    expect(asked?.pauseAt).toBe(pauseAt);
    expect(asked?.detail).toContain('In "Fix login".');
    expect(asked?.detail).toContain("Later waits another hour.");
    // Questions and no pause time: as before, no pause line or actions.
    const questionsOnly = describeAutomaticInstallWait([question("Fix login")], {
      pauseAt: null,
      nowMs,
    });
    expect(questionsOnly?.line).toBe("Update waits on 1 question.");
    expect(questionsOnly?.pauseAt).toBeUndefined();
    expect(questionsOnly?.pauseLine).toBeUndefined();
    // Not waiting on work, an older agent, or a time that does not parse: nothing.
    expect(describeAutomaticInstallWait([], { pauseAt: null, nowMs })).toBeNull();
    expect(describeAutomaticInstallWait([], { nowMs })).toBeNull();
    expect(describeAutomaticInstallWait([], { pauseAt: "soon", nowMs })).toBeNull();
  });

  it("shows the agent's message with Update now when its automatic pause did not happen", () => {
    const nowMs = Date.parse("2026-10-26T14:30:00.000Z");
    const message =
      "The automatic pause did not happen: a turn could not be paused. Choose Update now to install.";
    expect(describeAutomaticInstallWait([], { pauseAt: null, nowMs, message })).toEqual({
      line: message,
      detail:
        "The update could not pause running work on its own. Update now pauses the running turns, installs and restarts the background service, and the paused turns continue where they left off.",
      updateNow: true,
    });
    // Questions still lead; the message joins the tooltip and Update now is offered.
    const asked = describeAutomaticInstallWait([question("Fix login")], {
      pauseAt: null,
      nowMs,
      message,
    });
    expect(asked?.line).toBe("Update waits on 1 question.");
    expect(asked?.detail).toContain(message);
    expect(asked?.updateNow).toBe(true);
    // Any other message, or a pause time, is not a missed pause.
    expect(
      describeAutomaticInstallWait([], { pauseAt: null, nowMs, message: "Waiting for work." }),
    ).toBeNull();
    const scheduled = describeAutomaticInstallWait([], {
      pauseAt: "2026-10-26T14:41:00.000Z",
      nowMs,
      message,
    });
    expect(scheduled?.pauseAt).toBe("2026-10-26T14:41:00.000Z");
    expect(scheduled?.updateNow).toBeUndefined();
  });
});

describe("describeServiceUpdateRun", () => {
  it("shows step i of n with elapsed and expected time while the helper runs", () => {
    const view = describeServiceUpdateRun(
      run({
        step: {
          label: "checkBeforeRestart",
          i: 7,
          n: 16,
          phaseStartedAt: null,
          expectedMs: 160_000,
          serviceBack: false,
        },
      }),
      T0 + 95_000,
    );
    expect(view).toEqual({
      tone: "loading",
      title: "Installing SpecWithCode 1.0.70",
      lines: ["Step 7 of 16: check before restart.", "1:35 elapsed, about 2:40 expected."],
      warning: null,
      action: null,
      label: "Installing 7/16…",
    });
  });

  it("measures the install on the helper's clock, not from the press", () => {
    // Six minutes waiting for an answer, then the helper started.
    const helperStart = T0 + 6 * 60_000;
    const view = describeServiceUpdateRun(
      run({
        step: {
          label: "beforeRead",
          i: 1,
          n: 16,
          phaseStartedAt: new Date(helperStart).toISOString(),
          startedAt: new Date(helperStart).toISOString(),
          expectedMs: 240_000,
          serviceBack: false,
        },
      }),
      helperStart + 5_000,
    );
    expect(view.lines).toEqual([
      "Step 1 of 16: before read.",
      "0:05 elapsed, about 4:00 expected.",
    ]);
  });

  it("says the service is back while the helper finishes its checks", () => {
    const view = describeServiceUpdateRun(
      run({
        step: {
          label: "readiness",
          i: 14,
          n: 16,
          phaseStartedAt: null,
          expectedMs: null,
          serviceBack: true,
        },
      }),
      T0 + 120_000,
    );
    expect(view.lines).toEqual([
      RUN_SERVICE_BACK_LINE,
      "Step 14 of 16: readiness.",
      "2:00 elapsed.",
    ]);
  });

  it("says the running release is being put back while the helper rolls back", () => {
    const step = {
      label: "rollback",
      i: 14,
      n: 16,
      phaseStartedAt: null,
      expectedMs: 330_000,
      serviceBack: true,
    };
    const view = describeServiceUpdateRun(run({ step }), T0 + 190_000);
    expect(view).toMatchObject({
      tone: "loading",
      title: "Putting SpecWithCode back to the running version",
      action: null,
    });
    expect(view.lines).toEqual([RUN_ROLLBACK_LINE, "3:10 elapsed."]);
    expect(view.lines).not.toContain(RUN_SERVICE_BACK_LINE);
    // The helper ended without the release: the stale step is not shown as installing.
    for (const result of ["rolled-back", "held", "failed", "refused"]) {
      const ended = describeServiceUpdateRun(
        run({ step: { ...step, label: "readiness", result } }),
        T0 + 200_000,
      );
      expect(ended.title).toBe("SpecWithCode 1.0.70 was not installed");
      expect(ended.lines).toEqual([RUN_NOT_APPLIED_LINE, "3:20 elapsed."]);
    }
    // A verified result keeps the install's own words.
    expect(
      describeServiceUpdateRun(
        run({ step: { ...step, label: "readiness", result: "verified" } }),
        T0 + 200_000,
      ).lines[0],
    ).toBe(RUN_SERVICE_BACK_LINE);
  });

  it("states no progress in amber with no button, never a failure", () => {
    const view = describeServiceUpdateRun(run({ noProgress: true }), T0 + 10 * 60_000);
    expect(view).toMatchObject({ tone: "loading", warning: RUN_NO_PROGRESS_LINE, action: null });
  });

  it("names the threads a waiting run waits on", () => {
    expect(
      describeServiceUpdateRun(run({ phase: "waiting" }), T0, [question("Fix login")]).lines,
    ).toEqual(['Waiting for answers in "Fix login".']);
  });

  it("follows the app half once the service is verified", () => {
    const verified = run({ phase: "verified", appTargetVersion: "1.0.70" });
    expect(describeServiceUpdateRun(verified, T0)).toMatchObject({
      title: "Installing the SpecWithCode app 1.0.70",
      label: "Installing app update…",
      action: null,
    });
    expect(
      describeServiceUpdateRun({ ...verified, app: { phase: "relaunching", message: null } }, T0)
        .label,
    ).toBe("Restarting…");
  });

  it("offers an action only once the run is terminal", () => {
    const ended = { terminal: true, endedAt: new Date(T0 + 161_000).toISOString() };
    expect(
      describeServiceUpdateRun(run({ ...ended, phase: "verified", outcome: "updated" }), T0),
    ).toMatchObject({ tone: "success", title: "Updated to 1.0.70 in 2:41", action: null });
    expect(
      describeServiceUpdateRun(
        run({ ...ended, phase: "failed", outcome: "failed", message: "The snapshot failed." }),
        T0,
      ),
    ).toMatchObject({
      tone: "error",
      lines: ["The snapshot failed."],
      action: { kind: "retry", label: "Try again" },
    });
    expect(
      describeServiceUpdateRun(run({ ...ended, phase: "expired", outcome: "expired" }), T0).action,
    ).toEqual({ kind: "retry", label: "Try again" });
    expect(
      describeServiceUpdateRun(run({ ...ended, phase: "cancelled", outcome: "cancelled" }), T0)
        .action,
    ).toBeNull();
    // Not "Update cancelled / Update cancelled".
    expect(
      describeServiceUpdateRun(
        run({ ...ended, phase: "cancelled", outcome: "cancelled", message: "Update cancelled" }),
        T0,
      ).lines,
    ).toEqual([]);
    // A run with an app half took until the app was done, not until the service was.
    expect(
      describeServiceUpdateRun(
        run({
          ...ended,
          phase: "verified",
          outcome: "updated",
          appTargetVersion: "1.0.70",
          app: { phase: "done", message: null, finishedAt: new Date(T0 + 200_000).toISOString() },
        }),
        T0,
      ).title,
    ).toBe("Updated to 1.0.70 in 3:20");
    expect(
      describeServiceUpdateRun(
        run({
          ...ended,
          phase: "verified",
          appTargetVersion: "1.0.70",
          outcome: "failed",
          app: { phase: "failed", message: "App update did not apply." },
        }),
        T0,
      ),
    ).toMatchObject({
      lines: ["App update did not apply."],
      action: { kind: "restart-app", label: "Restart now" },
    });
  });
});

describe("formatting", () => {
  it("formats durations and step names", () => {
    expect(formatRunDuration(0)).toBe("0:00");
    expect(formatRunDuration(161_000)).toBe("2:41");
    expect(formatRunDuration(3_725_000)).toBe("1:02:05");
    expect(humanizeStep("checkBeforeRestart")).toBe("check before restart");
    expect(humanizeStep("before_read")).toBe("before read");
  });
});
