// Synthetic data only: no server, account, Connect session or store.
import type {
  ConnectDevice,
  ConnectDeviceRequest,
  ConnectDevicesSnapshot,
} from "@specweave-studio/contracts/connectDevices";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  type ConnectDevicesListActions,
  ConnectDevicesSectionView,
  DeviceApprovalPrompt,
  DeviceWaitingList,
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
  shortId: "H4WN",
  deviceType: "mobile",
  askedAt: "2026-11-13T23:10:00.000Z",
  expiresAt: "2026-11-13T23:20:00.000Z",
};

/** Two phones of one account that both call themselves "iPhone" (1406). */
const twoPhones: ReadonlyArray<ConnectDeviceRequest & { readonly code: string }> = [
  {
    id: "request-phone-a",
    kind: "connect",
    label: "iPhone",
    named: true,
    shortId: "TSKR",
    deviceType: "mobile",
    system: "iOS",
    app: "SpecWithCode",
    askedAt: "2026-11-13T23:10:00.000Z",
    expiresAt: "2026-11-13T23:20:00.000Z",
    code: "K7QX2M",
  },
  {
    id: "request-phone-b",
    kind: "connect",
    label: "iPhone",
    named: true,
    shortId: "9229",
    deviceType: "mobile",
    system: "iOS",
    app: "SpecWithCode",
    askedAt: "2026-11-13T23:11:00.000Z",
    expiresAt: "2026-11-13T23:21:00.000Z",
    code: "P4RT9W",
  },
];

/** The pop-up over a machine with two phones waiting: a typed code allows the phone that shows it. */
function TwoPhones({ note }: { note: (line: string) => void }) {
  const [pending, setPending] = useState(twoPhones);
  const [allowed, setAllowed] = useState<ReadonlyArray<ConnectDevice>>([]);
  return (
    <DeviceApprovalPrompt
      machine="m4"
      account="owner@example.com"
      requests={pending}
      allowed={allowed}
      onApprove={async (typed) => {
        const code = typed.replace(/[\s-]/g, "").toUpperCase();
        const match = pending.find((request) => request.code === code);
        if (!match)
          return "No device is waiting with that code. Check the code shown on the device that asked for m4.";
        note(`approve ${match.id}`);
        setPending((current) => current.filter((request) => request.id !== match.id));
        setAllowed((current) => [
          ...current,
          {
            key: `jkt:${match.id}`,
            kind: match.kind,
            label: match.label,
            named: true,
            shortId: match.shortId!,
            deviceType: "mobile",
            system: "iOS",
            app: "SpecWithCode",
            approvedAt: "2026-11-13T23:12:00.000Z",
            approvedBy: "this machine",
            keptByUpdate: false,
          },
        ]);
        return null;
      }}
      onDeny={async (id) => {
        note(`deny ${id}`);
        setPending((current) => current.filter((request) => request.id !== id));
      }}
      onLater={() => note("later")}
    />
  );
}

const snapshot: ConnectDevicesSnapshot = {
  machine: "m4",
  health: "ok",
  devices: [
    {
      key: "jkt:macbook",
      kind: "connect",
      label: "Anton's MacBook Air",
      shortId: "M7CB",
      deviceType: "desktop",
      approvedAt: "2026-11-13T22:40:00.000Z",
      approvedBy: "this machine",
      keptByUpdate: false,
    },
    {
      key: "jkt:ipad",
      kind: "connect",
      label: "Living room iPad",
      shortId: "P2DX",
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
            <DeviceWaitingList
              deviceId="9229"
              waiting={
                params.get("machines") === "3"
                  ? [
                      { id: "env-1", machine: "m4", code: "K7QX2M" },
                      { id: "env-2", machine: "Studio Mac", code: "P4RT9W" },
                      { id: "env-3", machine: "Build server", code: "D8HJ3N" },
                    ]
                  : [{ id: "env-1", machine: "m4", code: "K7QX2M" }]
              }
            />
          </div>
        </div>
        <div className="fixture-page">
          <div className="fixture-thread">m4 · Connecting…</div>
        </div>
      </div>
    );
  if (scene === "two-phones")
    return (
      <div className="fixture-shell">
        <div className="fixture-bar">SpecWithCode · m4</div>
        <div className="fixture-page">
          <div className="fixture-thread">Ship the device approval pop-up</div>
          <div className="fixture-thread">Weekly release notes</div>
        </div>
        <TwoPhones note={note} />
        {fixtureLog}
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
          requests={[iphone]}
          onApprove={actions.onApprove}
          onDeny={actions.onDeny}
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
