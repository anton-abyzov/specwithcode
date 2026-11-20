import type { FolderCopyOfferInput, FolderCopyStatus } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { syncOfferInput } from "../components/studio/useSyncOffer";
import { COPY_ROUTE_TEXT, copyRouteOf } from "./copyProgress";

const transport = (path: "lan" | "connect" | "mixed", bytesLan: number, bytesConnect: number) =>
  ({ transport: { path, bytesLan, bytesConnect } }) as Pick<FolderCopyStatus, "transport">;

describe("the route a copy took", () => {
  it("says nothing until file contents have moved, and on a machine that reports no route", () => {
    expect(copyRouteOf({})).toBeNull();
    expect(copyRouteOf(transport("connect", 0, 0))).toBeNull();
  });

  it("names the local network, Connect, or both", () => {
    expect(COPY_ROUTE_TEXT[copyRouteOf(transport("lan", 10, 0))!]).toBe("Over your local network");
    expect(COPY_ROUTE_TEXT[copyRouteOf(transport("connect", 0, 10))!]).toBe(
      "Over SpecWithCode Connect",
    );
    expect(COPY_ROUTE_TEXT[copyRouteOf(transport("mixed", 4, 6))!]).toBe(
      "Partly over your local network, the rest over SpecWithCode Connect",
    );
  });
});

describe("the Sync dialog's offer", () => {
  const input = { mode: "copy-only" } as FolderCopyOfferInput;

  it("names its purpose for a measured copy and never for a move", () => {
    expect(syncOfferInput(input).lanPurpose).toBe("sync-measured");
    const move = { ...input, mode: "copy-and-move" } as FolderCopyOfferInput;
    expect(syncOfferInput(move)).toBe(move);
  });
});
