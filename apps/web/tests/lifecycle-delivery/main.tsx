// Synthetic data only: no server, account, provider or store.
import * as DateTime from "effect/DateTime";
import { createRoot } from "react-dom/client";

import { ComposerBannerStack } from "../../src/components/chat/ComposerBannerStack";
import { lifecycleDeliveryBannerItem } from "../../src/components/chat/LifecycleDeliveryBanner";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const nowMs = Date.parse("2026-10-26T12:00:00Z");
const proof = {
  status: "verified" as const,
  reference: "https://github.com/anton-abyzov/specwithcode/pull/708",
  observedAt: "2026-10-26T11:00:00Z",
  scopeRevision: "abc123",
};
const receipt = {
  requestId: "request-1",
  runId: "run-1",
  acceptanceRevision: "run-1",
  requestedAt: "2026-10-26T10:00:00.000Z",
  kind: "code" as const,
  scope: "Evidence-backed lifecycle shipped in 1.0.93 and verified on the installed app",
  scopeRevision: "abc123",
  recordedAt: "2026-10-26T11:30:00Z",
  validUntil: "2026-10-27T11:30:00Z",
  reportedBy: "thread:completion-owner",
  obligations: [],
  push: proof,
  merge: proof,
  deployment: proof,
  deliverable: proof,
  verification: proof,
};
const projection = (id: string, lifecycleReceipt: unknown) =>
  ({
    thread: { id, lifecycleReceipt },
    runs: [
      {
        id: "run-1",
        ordinal: 1,
        status: "completed",
        userMessageId: "request-1",
        requestedAt: DateTime.makeUnsafe("2026-10-26T10:00:00Z"),
      },
    ],
    messages: [
      { id: "request-1", role: "user", createdAt: DateTime.makeUnsafe("2026-10-26T10:00:00Z") },
    ],
  }) as never;

const cases = [
  {
    id: "waiting",
    receipt: {
      ...receipt,
      deployment: { status: "pending", reason: "Main is held for the 1.0.92 release" },
      obligations: [
        {
          kind: "resource",
          reason:
            "ENOSPC: no space left on device stopped the test run; historical free space is not current evidence.",
          owner: "cleanup-owner",
          nextEvent: "verify recovered test capacity",
          needsUserOutput: false,
        },
        {
          kind: "deployment",
          reason: "Main is held for the 1.0.92 release.",
          owner: "release-owner",
          nextEvent: "installed acceptance receipt",
          needsUserOutput: false,
        },
      ],
    },
  },
  {
    id: "user",
    receipt: {
      ...receipt,
      obligations: [
        {
          kind: "user_action",
          reason: "Choose whether 1.0.93 ships to the stable channel.",
          owner: "Anton",
          nextEvent: "his answer",
          needsUserOutput: true,
        },
      ],
    },
  },
  {
    id: "pending",
    receipt: {
      ...receipt,
      deployment: { status: "pending", reason: "Release 1.0.93 has not installed yet" },
    },
  },
  { id: "expired", receipt: { ...receipt, validUntil: "2026-10-26T11:45:00Z" } },
  { id: "verified", receipt },
];

function App() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
      {cases.map(({ id, receipt: value }) => {
        const item = lifecycleDeliveryBannerItem(projection(`thread-${id}`, value), {
          settled: false,
          nowMs,
        });
        return (
          <section key={id} data-case={id} data-title={item?.title ?? ""}>
            {item ? <ComposerBannerStack items={[item]} /> : null}
          </section>
        );
      })}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
