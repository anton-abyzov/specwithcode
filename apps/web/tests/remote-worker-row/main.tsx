// Synthetic data only: no server, account, provider or store.
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";
import { createRoot } from "react-dom/client";

import { RemoteWorkerCard } from "../../src/components/studio/RemoteWorkerCards";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const base: StudioFleetRemoteWorker = {
  id: "rwt:1",
  machineId: "anton-s-macbook-m4max",
  machineLabel: "m4",
  environmentId: EnvironmentId.make("env-m4"),
  callerThreadId: ThreadId.make("coordinator"),
  remoteThreadId: null,
  threadRef: null,
  title: "Read back installed SpecWithCode versions on m4",
  state: "launch_unknown",
  lastStatus: null,
  reachable: false,
  updatedAt: "2026-11-18T00:00:00.000Z",
} as StudioFleetRemoteWorker;

// The two rows from the report: a start m4 never confirmed, and a run on m4 while m4 is
// not connected here. Then one this browser can open, for the button's room.
const cases: { id: string; worker: StudioFleetRemoteWorker; open: boolean; checking?: boolean }[] =
  [
    { id: "unconfirmed", worker: base, open: false },
    {
      id: "unreachable",
      worker: {
        ...base,
        id: "rwt:2",
        title: "Installed m4 check: machine colours and full-screen restore",
        state: "following",
        remoteThreadId: ThreadId.make("b-thread"),
        threadRef: "studio://thread/env-m4/b-thread",
      } as StudioFleetRemoteWorker,
      open: false,
    },
    {
      id: "checking",
      worker: {
        ...base,
        id: "rwt:3",
        title: "Window placement trace",
        state: "following",
        reachable: true,
        remoteThreadId: ThreadId.make("c-thread"),
      } as StudioFleetRemoteWorker,
      open: false,
      checking: true,
    },
    {
      id: "openable",
      worker: {
        ...base,
        id: "rwt:4",
        title: "Disk benchmark on m4",
        state: "following",
        reachable: true,
        remoteThreadId: ThreadId.make("d-thread"),
      } as StudioFleetRemoteWorker,
      open: true,
    },
  ];

function Fixture() {
  return (
    <main className="flex flex-col gap-4 p-3">
      <ul className="sws-thread-cards" data-placement="pane" aria-label="Workers on other machines">
        {cases.map((entry) => (
          <li key={entry.id} data-case={entry.id}>
            <RemoteWorkerCard
              worker={entry.worker}
              onOpen={entry.open ? () => undefined : null}
              checking={entry.checking ?? false}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
