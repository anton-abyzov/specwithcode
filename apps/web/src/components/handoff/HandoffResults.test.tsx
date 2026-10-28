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
    for (const outcome of ["Moved", "Stayed", "Skipped"]) expect(html).toContain(`>${outcome}<`);
  });

  it("says so when nothing was set to keep ready to move", () => {
    expect(
      renderToStaticMarkup(
        <HandoffMachineResults run={{ ...run, results: [] }} destinationName="Minis" />,
      ),
    ).toContain("Nothing was running here that&#x27;s set to keep ready to move.");
  });
});
