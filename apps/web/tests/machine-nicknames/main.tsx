// Synthetic data only: no server, account or store.
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type {
  StudioFleetRemoteWorker,
  StudioFleetSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { createRoot } from "react-dom/client";

import { RemoteWorkerCardList } from "../../src/components/studio/RemoteWorkerCards";
import { threadMoveBanner } from "../../src/components/threadMove.logic";
import { workerMachineChoices } from "../../src/studio/fleetWorkers";
import { machineNickname } from "./stubs/machineNickname";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/index.css";
import "../../src/components/studio/shell/shell.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const env = (id: string) => id as EnvironmentId;
const now = new Date().toISOString();
const worker = (id: string, environmentId: string, machineLabel: string, title: string) =>
  ({
    id,
    machineId: id,
    machineLabel,
    environmentId: env(environmentId),
    callerThreadId: "caller" as ThreadId,
    remoteThreadId: null,
    threadRef: null,
    title,
    state: "following",
    lastStatus: null,
    reachable: true,
    updatedAt: now,
  }) as unknown as StudioFleetRemoteWorker;

const workers = [
  worker("w1", "env-m1", "Anton's MacBook Pro M1Max (190)", "Port machine nicknames"),
  worker("w4", "env-m4", "Anton's MacBook Pro M4 Max", "Sign Linux releases"),
];

const banner = threadMoveBanner(
  {
    environmentId: env("env-here"),
    id: "t1" as ThreadId,
    movedTo: {
      kind: "handoff",
      environmentId: env("env-m1"),
      machineLabel: "Anton's MacBook Pro M1Max (190)",
      threadId: "t2" as ThreadId,
    } as never,
  },
  () => undefined,
  machineNickname as never,
);

const snapshot = {
  machines: [
    {
      id: "m1",
      environmentId: env("env-m1"),
      label: "Anton's MacBook Pro M1Max (190)",
      url: "https://m1.fixture.ts.net",
      status: "reachable",
      pairingConfigured: true,
      workers: { status: "allowed" },
    },
    {
      id: "mini",
      environmentId: env("env-mini"),
      label: "Anton's Mac mini (Office)",
      url: "https://mini.fixture.ts.net",
      status: "reachable",
      pairingConfigured: true,
      workers: { status: "allowed" },
    },
  ],
} as unknown as StudioFleetSnapshot;
const choices = (workerMachineChoices as (...args: unknown[]) => ReadonlyArray<{ label: string }>)(
  snapshot,
  env("env-here"),
  [],
  machineNickname,
);

function Page() {
  return (
    <div className="bg-background p-4 text-foreground" style={{ minHeight: "100vh" }}>
      <section data-case="banner" className="mb-4 rounded-lg border border-border p-3 text-sm">
        <div className="font-medium">{banner?.title}</div>
        <div className="text-muted-foreground">{banner?.description}</div>
        <div className="mt-1 text-xs text-primary">{banner?.actionLabel}</div>
      </section>
      <section data-case="workers" className="mb-4">
        <RemoteWorkerCardList workers={workers} />
      </section>
      <section data-case="picker" className="rounded-lg border border-border p-3 text-sm">
        <div className="mb-1 text-xs text-muted-foreground">Workers may run on</div>
        <ul className="space-y-1">
          {choices.map((choice) => (
            <li key={choice.label}>{choice.label}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
