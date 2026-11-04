// Synthetic data only: no server, account, provider or store.
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import type { OrchestrationV2PendingAccessRequest } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { CoordinatorAccessWaiting } from "../../src/components/studio/CoordinatorAccessWaiting";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { accessWaitingThreads, remoteWorkerThreads } from "../../src/studio/accessWaiting";
import { makeThreadFixture } from "../../src/test-fixtures";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);

function waitingThread(
  id: string,
  title: string,
  at: string,
  access: OrchestrationV2PendingAccessRequest,
): EnvironmentThreadShell {
  const base = makeThreadFixture({ id: ThreadId.make(id), title });
  return {
    ...base,
    runtime: { ...base.runtime, status: "running" } as EnvironmentThreadShell["runtime"],
    hasPendingApprovals: true,
    source: {
      ...base.source!,
      status: "running",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make(`turn-item:access-request:${id}`),
        kind: "permission",
        createdAt: DateTime.makeUnsafe(at),
        access,
      },
    },
  };
}

const threads = [
  waitingThread(
    "thread-showcase",
    "Launch SpecWithCode iPhone Duo showcase",
    "2026-11-04T12:18:00.000Z",
    {
      accessTitle: "Use Notes",
      reason: "Draft the launch post in Notes from the showcase captions.",
      subjects: [{ kind: "app", label: "Notes", hostLabel: "M4" }],
    },
  ),
  waitingThread("thread-sim", "Verify the pairing flow on iPhone", "2026-11-04T12:19:00.000Z", {
    accessTitle: "Control iPhone 17 Pro",
    reason: "To run the pairing flow end to end on a simulator.",
    subjects: [{ kind: "device", label: "iPhone 17 Pro" }],
  }),
];

// A worker the coordinator started on another machine, as that host's thread list has it.
const M1 = EnvironmentId.make("environment-m1");
const remoteShells = [
  {
    ...waitingThread(
      "thread-remote",
      "Rebuild the Linux release on M1",
      "2026-11-04T12:20:00.000Z",
      {
        accessTitle: "Work on M1",
        reason: "To run the Linux release build on that machine.",
        subjects: [{ kind: "machine", label: "M1" }],
      },
    ),
    environmentId: M1,
  },
];
const remoteWorkers = [
  {
    environmentId: M1,
    remoteThreadId: ThreadId.make("thread-remote"),
    state: "following" as const,
  },
];

function Fixture() {
  const [opened, setOpened] = useState<string | null>(null);
  const entries = accessWaitingThreads(
    [...threads, ...remoteWorkerThreads(remoteShells, remoteWorkers)],
    (thread) => (thread.environmentId === M1 ? "Anton's Mac mini M1" : "Anton's MacBook M1"),
  );
  return (
    <div className="sws-coordinator">
      <div className="project-conversation" data-case="coordinator">
        <div className="project-message project-message-user">
          <p>Make the iPhone Duo showcase images and check pairing still works.</p>
        </div>
        <div className="project-message project-message-assistant">
          <p>
            I started two threads: one captures the showcase screenshots, the other runs the pairing
            flow on a simulator. Both need your go-ahead before they touch anything.
          </p>
        </div>
        <CoordinatorAccessWaiting
          entries={entries}
          onOpenThread={(t) => setOpened(`${t.environmentId}/${t.id}`)}
        />
        <p className="fixture-opened" data-opened={opened ?? ""}>
          {opened ? `Opened ${opened}` : ""}
        </p>
      </div>
      <div className="fixture-composer">Message the coordinator</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
);
