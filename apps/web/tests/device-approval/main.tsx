// Synthetic data only: no server, account, Connect session or store.
import type { ConnectDevicesSnapshot } from "@specweave-studio/contracts/connectDevices";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  type ConnectDevicesListActions,
  ConnectDevicesSectionView,
  DeviceApprovalPrompt,
  DeviceWaitingCard,
} from "../../src/components/devices/ConnectDeviceViews";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const scene = params.get("scene") ?? "list";

const iphone = {
  id: "request-iphone",
  kind: "phone" as const,
  label: "Anton's iPhone",
  deviceType: "mobile",
  askedAt: "2026-11-13T23:10:00.000Z",
  expiresAt: "2026-11-13T23:20:00.000Z",
};

const snapshot: ConnectDevicesSnapshot = {
  machine: "m4",
  health: "ok",
  devices: [
    {
      key: "jkt:macbook",
      kind: "connect",
      label: "Anton's MacBook Air",
      deviceType: "desktop",
      approvedAt: "2026-11-13T22:40:00.000Z",
      approvedBy: "this machine",
      keptByUpdate: false,
    },
    {
      key: "jkt:ipad",
      kind: "connect",
      label: "Living room iPad",
      deviceType: "tablet",
      approvedAt: "2026-11-12T18:00:00.000Z",
      approvedBy: "the update",
      keptByUpdate: true,
    },
  ],
  pending: [iphone],
  needsReview: true,
  notices: [],
  canApprove: true,
  canRepair: true,
};

function Fixture() {
  const [log, setLog] = useState<Array<string>>([]);
  const note = (line: string) => setLog((current) => [...current, line]);
  const actions: ConnectDevicesListActions = {
    onApprove: async (code) => {
      note(`approve ${code}`);
      return code.replace(/[\s-]/g, "").toUpperCase() === "K7QX2M"
        ? null
        : "No device is waiting with that code. Check the code shown on the device that asked for m4.";
    },
    onDeny: async (id) => note(`deny ${id}`),
    onRemove: async (device) => note(`remove ${device.key}`),
    onConfirmReview: async () => note("review"),
    onRepair: async () => note("repair"),
  };
  const fixtureLog = (
    <output className="sr-only" data-fixture-log={log.join("|")}>
      {log.join("|")}
    </output>
  );
  if (scene === "waiting")
    return (
      <div className="fixture-shell">
        <div className="fixture-bar">SpecWithCode · Anton's iPhone</div>
        <div className="pointer-events-none fixed inset-x-0 top-14 z-50 flex flex-col items-center gap-2">
          <div className="pointer-events-auto">
            <DeviceWaitingCard machine="m4" code="K7QX2M" />
          </div>
        </div>
        <div className="fixture-page">
          <div className="fixture-thread">m4 · Connecting…</div>
        </div>
      </div>
    );
  if (scene === "prompt")
    return (
      <div className="fixture-shell">
        <div className="fixture-bar">SpecWithCode · m4</div>
        <div className="fixture-page">
          <div className="fixture-thread">Ship the device approval pop-up</div>
          <div className="fixture-thread">Weekly release notes</div>
        </div>
        <DeviceApprovalPrompt
          machine="m4"
          request={iphone}
          position={1}
          total={1}
          onApprove={actions.onApprove}
          onDeny={() => actions.onDeny(iphone.id)}
          onLater={() => note("later")}
        />
        {fixtureLog}
      </div>
    );
  return (
    <div className="fixture-page" style={{ paddingTop: 24 }}>
      <ConnectDevicesSectionView
        supported={params.get("supported") !== "no"}
        snapshot={params.get("damaged") ? { ...snapshot, health: "damaged" } : snapshot}
        error={null}
        actions={actions}
      />
      {fixtureLog}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
);
