import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffPreflightResult,
  ThreadId,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HandoffMachineResults, HandoffPreflightPanel } from "./HandoffResults";

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
    expect(html).toContain("Stays here: a check failed.");
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
    ).toContain("Ready. Its turn continues there.");
    expect(
      renderToStaticMarkup(
        <HandoffPreflightPanel
          preflight={{ state: "done", results: [preflight({ resume: false })] }}
        />,
      ),
    ).toContain("It moves without starting a turn.");
  });

  it("names a check that could not run", () => {
    expect(
      renderToStaticMarkup(
        <HandoffPreflightPanel
          preflight={{ state: "error", message: "Minis is not connected." }}
        />,
      ),
    ).toContain("Couldn&#x27;t check: Minis is not connected.");
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
    expect(html).toContain("Its turn continues on Minis.");
    expect(html).toContain('data-outcome="stayed"');
    expect(html).toContain("Minis: no .env.local");
    expect(html).toContain('data-outcome="skipped"');
    expect(html).toContain("Not running");
  });

  it("says so when nothing was in handoff mode", () => {
    expect(
      renderToStaticMarkup(
        <HandoffMachineResults run={{ ...run, results: [] }} destinationName="Minis" />,
      ),
    ).toContain("No running thread was in handoff mode.");
  });
});
