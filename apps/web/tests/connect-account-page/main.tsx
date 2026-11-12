import type { EnvironmentId } from "@specweave-studio/contracts";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { StudioConnectMachinesView } from "../../src/components/clerk/StudioConnectUserProfilePage";
import "./fixture.css";

// The Machines page of the account modal in every state, with the real view.
// Open it with ?state=list|confirm|confirm-current|pending|loading|empty|error|stale
// &theme=light|dark.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const state = params.get("state") ?? "list";

const machine = (id: string, label: string, linkedAt: string): RelayClientEnvironmentRecord => ({
  environmentId: id as EnvironmentId,
  label,
  endpoint: {
    httpBaseUrl: `https://${id}.example.com`,
    wsBaseUrl: `wss://${id}.example.com`,
    providerKind: "cloudflare_tunnel",
  },
  linkedAt,
});
const MACHINES = [
  machine("m1", "Ada’s MacBook Pro M1 Max", "2026-10-26T12:00:00.000Z"),
  machine("m4", "Ada’s MacBook M4 Max", "2026-10-28T12:00:00.000Z"),
  machine("pc", "WORKSTATION-ADA-LOVELACE-ENGINEERING-01", "2026-11-02T12:00:00.000Z"),
  machine("m3", "Ada’s MacBook Pro", "2026-10-26T12:00:00.000Z"),
  machine("mini", "minisforum", "2026-10-26T12:00:00.000Z"),
];
const CURRENT = "m4" as EnvironmentId;
const noop = () => {};

function Page() {
  const [confirming, setConfirming] = useState<EnvironmentId | null>(
    state === "confirm" || state === "pending"
      ? ("mini" as EnvironmentId)
      : state === "confirm-current"
        ? CURRENT
        : null,
  );
  return (
    <StudioConnectMachinesView
      environments={state === "empty" || state === "loading" || state === "error" ? [] : MACHINES}
      currentEnvironmentId={CURRENT}
      loading={state === "loading"}
      refreshing={false}
      error={
        state === "error" || state === "stale"
          ? "SpecWithCode Connect did not answer. Check this machine's connection."
          : null
      }
      confirmingEnvironmentId={confirming}
      deregisteringEnvironmentId={state === "pending" ? ("mini" as EnvironmentId) : null}
      onRefresh={noop}
      onConfirmationChange={setConfirming}
      onDeregister={noop}
    />
  );
}

// The frame stands in for the account modal's content pane.
createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-background p-4 sm:p-8">
    <main className="mx-auto max-w-[36rem] rounded-2xl border bg-card p-5 shadow-sm sm:p-7">
      <Page />
    </main>
  </div>,
);
