import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { lifecycleDeliveryBannerItem } from "./LifecycleDeliveryBanner";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const nowMs = Date.parse("2026-10-26T12:00:00Z");
const proof = {
  status: "verified" as const,
  reference: "https://example.test/release/1",
  observedAt: "2026-10-26T11:00:00Z",
  scopeRevision: "abc123",
};
const receipt = {
  requestId: "request-1",
  runId: "run-1",
  acceptanceRevision: "run-1",
  requestedAt: "2026-10-26T10:00:00.000Z",
  kind: "code" as const,
  scope: "Fix installed and verified",
  scopeRevision: "abc123",
  recordedAt: "2026-10-26T11:30:00Z",
  validUntil: "2026-10-27T11:30:00Z",
  reportedBy: "thread:completion-owner",
  obligations: [] as Array<{
    kind: "resource" | "deployment";
    reason: string;
    owner: string;
    nextEvent: string;
    needsUserOutput: boolean;
  }>,
  push: proof,
  merge: proof,
  deployment: proof,
  deliverable: proof,
  verification: proof,
};
const projection = (lifecycleReceipt: typeof receipt | null) =>
  ({
    thread: { id: "thread-1", lifecycleReceipt },
    runs: [
      {
        id: "run-1",
        ordinal: 1,
        status: "completed",
        userMessageId: "request-1",
        requestedAt: at("2026-10-26T10:00:00Z"),
      },
    ],
    messages: [{ id: "request-1", role: "user", createdAt: at("2026-10-26T10:00:00Z") }],
  }) as never;

describe("lifecycleDeliveryBannerItem", () => {
  it("shows nothing for legacy threads or a resolved thread's verified delivery", () => {
    expect(lifecycleDeliveryBannerItem(projection(null), { settled: false, nowMs })).toBeNull();
    expect(lifecycleDeliveryBannerItem(projection(receipt), { settled: true, nowMs })).toBeNull();
    expect(
      lifecycleDeliveryBannerItem(projection(receipt), { settled: false, nowMs }),
    ).toMatchObject({ variant: "success", title: "Delivery verified" });
  });

  it("never contradicts a resolved thread once its evidence expires", () => {
    const later = Date.parse("2026-10-28T09:00:00Z");
    expect(
      lifecycleDeliveryBannerItem(projection(receipt), { settled: true, nowMs: later }),
    ).toBeNull();
    expect(
      lifecycleDeliveryBannerItem(projection(receipt), { settled: false, nowMs: later }),
    ).toMatchObject({ variant: "warning", title: "Delivery evidence expired" });
  });

  it("treats evidence recorded later in the view's current minute as current", () => {
    const recorded = { ...receipt, recordedAt: "2026-10-26T11:30:40Z" };
    const minute = Date.parse("2026-10-26T11:30:00Z");
    expect(
      lifecycleDeliveryBannerItem(projection(recorded), { settled: false, nowMs: minute }),
    ).toMatchObject({ variant: "success", title: "Delivery verified" });
    expect(
      lifecycleDeliveryBannerItem(projection({ ...recorded, recordedAt: "2026-10-26T11:32:00Z" }), {
        settled: false,
        nowMs: minute,
      }),
    ).toMatchObject({ variant: "warning", title: "Delivery evidence expired" });
  });

  it("lists every owned wait with its owner and next event", () => {
    const item = lifecycleDeliveryBannerItem(
      projection({
        ...receipt,
        obligations: [
          {
            kind: "resource",
            reason: "ENOSPC stopped the test run.",
            owner: "cleanup-owner",
            nextEvent: "verify free space",
            needsUserOutput: false,
          },
          {
            kind: "deployment",
            reason: "Release is held for 1.0.92.",
            owner: "release-owner",
            nextEvent: "installed acceptance",
            needsUserOutput: false,
          },
        ],
      }),
      { settled: false, nowMs },
    );
    expect(item).toMatchObject({ variant: "info", title: "Operational wait" });
    const markup = renderToStaticMarkup(<>{item?.description}</>);
    expect(markup).toContain("Owner: cleanup-owner. Next: verify free space.");
    expect(markup).toContain("Owner: release-owner. Next: installed acceptance.");
  });

  it("warns when evidence expired or a gate is pending", () => {
    expect(
      lifecycleDeliveryBannerItem(projection({ ...receipt, validUntil: "2026-10-26T11:45:00Z" }), {
        settled: false,
        nowMs,
      }),
    ).toMatchObject({ variant: "warning", title: "Delivery evidence expired" });
    expect(
      lifecycleDeliveryBannerItem(
        projection({
          ...receipt,
          deployment: { status: "pending", reason: "Release held" } as never,
        }),
        { settled: false, nowMs },
      ),
    ).toMatchObject({
      variant: "warning",
      title: "Delivery not verified",
      description: "Deployment: Release held",
    });
  });
});
