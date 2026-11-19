import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffPreflightResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  HandoffMachineResults,
  HandoffPreflightPanel,
  destinationNeedsUpdate,
  destinationsNeedingUpdate,
  needsUpdateMachine,
  versionFailureNamesDestination,
  type HandoffDestination,
} from "./HandoffResults";
import { HandOffProgressView, type HandOffProgressViewRow } from "./HandOffProgress";
import type { HandOffRowState } from "./handOffProgress.logic";
import { destinationOptions } from "./MachineOptionRows";

const preflight = (patch: Partial<HandoffPreflightResult>): HandoffPreflightResult =>
  ({
    threadId: "thread-1" as ThreadId,
    title: "Fix the build",
    ok: true,
    failures: [],
    resume: true,
    runEnding: "active",
    ...patch,
  }) as HandoffPreflightResult;

describe("HandoffPreflightPanel", () => {
  it("lists every failed check verbatim", () => {
    const html = renderToStaticMarkup(
      <HandoffPreflightPanel
        machine="Minis"
        preflight={{
          state: "done",
          results: [
            preflight({
              ok: false,
              failures: [
                { check: "ignored-files", message: "Minis: no .env.local" },
                { check: "provider", message: "Minis: Claude not signed in" },
              ],
            }),
          ],
        }}
      />,
    );
    expect(html).toContain("Minis can&#x27;t take it yet:");
    expect(html).toContain('role="status"');
    expect(html).toContain('data-check="ignored-files"');
    expect(html).toContain("Minis: no .env.local");
    expect(html.indexOf("Minis: no .env.local")).toBeLessThan(
      html.indexOf("Minis: Claude not signed in"),
    );
  });

  it("says whether the turn continues on the destination", () => {
    expect(
      renderToStaticMarkup(
        <HandoffPreflightPanel preflight={{ state: "done", results: [preflight({})] }} />,
      ),
    ).toContain("Ready. The current turn keeps running there.");
    expect(
      renderToStaticMarkup(
        <HandoffPreflightPanel
          preflight={{ state: "done", results: [preflight({ resume: false })] }}
        />,
      ),
    ).toContain("Ready. It will wait there for your next message.");
  });

  it('drops "there" when the thread stays on this machine', () => {
    const ready = renderToStaticMarkup(
      <HandoffPreflightPanel
        machine="M4"
        here
        preflight={{ state: "done", results: [preflight({})] }}
      />,
    );
    expect(ready).toContain("Ready. The current turn keeps running.");
    expect(ready).not.toContain("there");
    expect(
      renderToStaticMarkup(
        <HandoffPreflightPanel
          here
          preflight={{ state: "done", results: [preflight({ resume: false })] }}
        />,
      ),
    ).toContain("Ready. It will wait for your next message.");
    const failed = renderToStaticMarkup(
      <HandoffPreflightPanel
        machine="M4"
        here
        preflight={{
          state: "done",
          results: [
            preflight({
              ok: false,
              failures: [{ check: "provider", message: "M4: Codex not signed in" }],
            }),
          ],
        }}
      />,
    );
    expect(failed).toContain("Can&#x27;t switch yet:");
    expect(failed).not.toContain("M4 can&#x27;t take it yet");
    expect(failed).toContain('data-check="provider"');
  });

  it("names the machine it is checking", () => {
    expect(
      renderToStaticMarkup(
        <HandoffPreflightPanel machine="Minis" preflight={{ state: "checking" }} />,
      ),
    ).toContain("Checking Minis…");
  });

  it("names a machine it could not reach, as an alert", () => {
    const html = renderToStaticMarkup(
      <HandoffPreflightPanel
        machine="Minis"
        preflight={{ state: "error", message: "Minis is not connected." }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t reach Minis: Minis is not connected.");
  });
});

describe("HandoffMachineResults", () => {
  const run: HandoffMachineRun = {
    destinationEnvironmentId: "env-minis" as EnvironmentId,
    destinationLabel: "Minis",
    reason: "manual",
    startedAt: "2026-10-20T20:00:00.000Z",
    finishedAt: "2026-10-20T20:00:05.000Z",
    results: [
      {
        threadId: "a" as ThreadId,
        title: "Fix the build",
        outcome: "moved",
        detail: null,
        continuedThreadId: "a2" as ThreadId,
        resumed: true,
      },
      {
        threadId: "b" as ThreadId,
        title: "Write docs",
        outcome: "stayed",
        detail: "Minis: no .env.local",
        continuedThreadId: null,
        resumed: false,
      },
      {
        threadId: "c" as ThreadId,
        title: "Old chat",
        outcome: "skipped",
        detail: "Not running",
        continuedThreadId: null,
        resumed: false,
      },
    ],
  } as HandoffMachineRun;

  it("shows one result per thread: moved, stayed with the reason, skipped", () => {
    const html = renderToStaticMarkup(
      <HandoffMachineResults run={run} destinationName="Minis" onOpenThread={() => {}} />,
    );
    expect(html.match(/data-outcome=/g)).toHaveLength(3);
    expect(html).toContain('data-outcome="moved"');
    expect(html).toContain("Open on Minis");
    expect(html).toContain("The current turn keeps running on Minis.");
    expect(html).toContain('data-outcome="stayed"');
    expect(html).toContain("Minis: no .env.local");
    expect(html).toContain('data-outcome="skipped"');
    expect(html).toContain("Not running");
    for (const outcome of ["Handed off", "Stayed", "Skipped"])
      expect(html).toContain(`>${outcome}<`);
  });

  it("says so when nothing was unfinished", () => {
    expect(
      renderToStaticMarkup(
        <HandoffMachineResults run={{ ...run, results: [] }} destinationName="Minis" />,
      ),
    ).toContain("Nothing running here can go.");
  });
});

describe("a machine without transfer records", () => {
  // The two sentences the server sends, exactly: the preflight check and a missing peer path.
  const fromCheck =
    "Needs update: Desk runs a SpecWithCode from before handoff transfer records, so no thread moves between it and this machine. Update SpecWithCode on Desk first.";
  const fromPath =
    "Needs update: Desk runs a SpecWithCode from before handoff transfer records. Update SpecWithCode on Desk first.";
  const fromSource =
    "Desk: Needs update: The source machine runs a SpecWithCode from before handoff transfer records, so no thread moves between it and this machine. Update SpecWithCode on The source machine first.";
  const failed = (message: string) =>
    preflight({ ok: false, failures: [{ check: "version", message }] });
  const destinations: HandoffDestination[] = [
    { environmentId: "env-desk" as EnvironmentId, label: "Desk", state: "reachable" },
    { environmentId: "env-mini" as EnvironmentId, label: "Mini", state: "reachable" },
  ];

  it("names the machine to update from either sentence", () => {
    expect(needsUpdateMachine([failed(fromCheck)])).toBe("Desk");
    expect(needsUpdateMachine([failed(fromPath)])).toBe("Desk");
    expect(needsUpdateMachine([failed(fromSource)])).toBe("The source machine");
    expect(needsUpdateMachine([preflight({})])).toBeNull();
    expect(
      needsUpdateMachine([
        preflight({ ok: false, failures: [{ check: "provider", message: fromCheck }] }),
      ]),
    ).toBeNull();
  });

  it("offers the update for the destination both sentences name", () => {
    expect(versionFailureNamesDestination([failed(fromCheck)])).toBe(true);
    expect(versionFailureNamesDestination([failed(fromPath)])).toBe(true);
  });

  it("shows the row as Needs update and never as a choice", () => {
    const marked = destinationsNeedingUpdate(destinations, new Set(["env-desk" as EnvironmentId]));
    const [desk, mini] = destinationOptions(marked);
    expect(desk).toMatchObject({ label: "Desk", reason: "Needs update", disabled: true });
    expect(mini).toMatchObject({ label: "Mini", tone: "ready" });
    expect(mini?.disabled).toBeUndefined();
  });

  it("marks no destination when the source is the one to update", () => {
    expect(destinationNeedsUpdate([failed(fromSource)])).toBe(false);
    expect(versionFailureNamesDestination([failed(fromSource)])).toBe(false);
    expect(destinationNeedsUpdate([failed(fromCheck)])).toBe(true);
    expect(destinationNeedsUpdate([failed(fromPath)])).toBe(true);
  });
});

describe("HandOffProgressView", () => {
  const row = (
    state: HandOffRowState,
    title: string,
    patch: Partial<HandOffProgressViewRow> = {},
  ): HandOffProgressViewRow => ({
    operationId: `op-${title}`,
    threadId: `thread-${title}` as ThreadId,
    sourceEnvironmentId: "env-laptop" as EnvironmentId,
    targetEnvironmentId: "env-desk" as EnvironmentId,
    state,
    finished: ["resumed", "ready", "stayed", "failed"].includes(state),
    action:
      state === "held"
        ? "resume-here"
        : state === "pending"
          ? null
          : state === "waiting"
            ? "wait"
            : state === "failed"
              ? "try-again"
              : state === "stayed"
                ? null
                : "open",
    continuedThreadId: state === "resumed" || state === "ready" ? ("there" as ThreadId) : null,
    detail: null,
    sentAt: null,
    modelSelection: null,
    title,
    ...patch,
  });
  const noop = () => {};
  const render = (
    rows: HandOffProgressViewRow[],
    extra: Partial<Parameters<typeof HandOffProgressView>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <HandOffProgressView
        projectName="atlas"
        sourceName="Laptop"
        targetName="Desk"
        trigger={{ kind: "manual" }}
        rows={rows}
        onRelease={noop}
        onOpen={noop}
        onRetry={noop}
        formatTime={() => "2:41 AM"}
        {...extra}
      />,
    );
  const rowHtml = (html: string, state: HandOffRowState) =>
    html.split("<li").find((part) => part.includes(`data-row-state="${state}"`)) ?? "";

  it("shows the project in quotes, the reason, and a bar from the same rows as the summary", () => {
    const html = render(
      [
        row("resumed", "One"),
        row("failed", "Two", { detail: "Desk: Claude not signed in" }),
        row("waiting", "Three", { sentAt: "2026-11-19T07:41:00.000Z" }),
        row("held", "Four"),
      ],
      { trigger: { kind: "automatic", reason: "Complex track out of tokens on Laptop" } },
    );
    expect(html).toContain("Hand off “atlas” to Desk");
    expect(html).toContain("Complex track out of tokens on Laptop");
    expect(html).toContain("2 of 4 finished: 1 resumed, 1 failed");
    expect(html).toContain('data-percent="50"');
    expect(html).toContain("width:50%");
    expect(html).toContain("Desk: Claude not signed in");
    expect(html).toContain("Sent at 2:41 AM. Desk has not answered yet");
    expect(html).not.toContain("All 4 on Desk");
  });

  it("offers Resume here on a hold never sent, and only a word on a thread that was sent", () => {
    const html = render([row("held", "Held"), row("waiting", "Sent"), row("pending", "Later")]);
    expect(rowHtml(html, "held")).toContain(">Resume here</button>");
    expect(rowHtml(html, "pending")).not.toContain("<button");
    const waiting = rowHtml(html, "waiting");
    expect(waiting).toContain("Waiting for confirmation");
    expect(waiting).toContain(">Wait</span>");
    expect(waiting).not.toContain("<button");
    expect(html).toContain(
      "Waiting is not failed. Laptop runs none of these threads while Desk has not answered.",
    );
  });

  it("says who asked for a hand off started by hand, and what Ready means", () => {
    const html = render([
      row("ready", "Idle"),
      row("stayed", "Asked", { detail: "Answer it first" }),
    ]);
    expect(html).toContain("You asked to hand off to Desk");
    expect(html).toContain("2 of 2 finished: 1 ready, 1 stayed");
    expect(html).toContain("Ready on Desk");
    expect(html).toContain(">Open on Desk</button>");
    expect(html).toContain("Answer it first");
    expect(html).toContain("Ready means installed idle: nothing starts on Desk until you write.");
  });

  it("shows that no machine has the track in place of the bar", () => {
    const out = (resets: Array<{ machineLabel: string; resetsAt: string | null }>) =>
      render([], {
        trigger: { kind: "automatic" },
        trackOut: { track: "Complex", staying: 2, resets },
      });
    const known = out([
      { machineLabel: "Laptop", resetsAt: "2026-11-19T11:30:00.000Z" },
      { machineLabel: "Desk", resetsAt: "2026-11-19T09:10:00.000Z" },
    ]);
    expect(known).toContain("Hand off “atlas”<");
    expect(known).toContain("Complex track out of tokens on Laptop");
    expect(known).toContain("Complex track is out on every machine");
    expect(known).toContain("2 threads stay on Laptop. Nothing moves.");
    expect(known).toContain("Next reset: Desk at 2:41 AM");
    expect(known).not.toContain('role="progressbar"');
    const unknown = out([{ machineLabel: "Laptop", resetsAt: null }]);
    expect(unknown).toContain("Reset unknown");
    expect(unknown).not.toContain("Next reset");
  });
});
