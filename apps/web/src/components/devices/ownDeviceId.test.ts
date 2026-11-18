import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const stored = vi.hoisted(() => ({
  key: null as { thumbprint: string } | null,
  fails: false,
  reads: 0,
}));
vi.mock("../../cloud/dpop", () => ({
  readStoredBrowserDpopKey: () => {
    stored.reads += 1;
    return stored.fails ? Effect.fail({ _tag: "NoDatabase" } as const) : Effect.succeed(stored.key);
  },
}));

import { loadOwnDeviceShortId } from "./ownDeviceId";

describe("this window's own short device ID (1406)", () => {
  beforeEach(() => {
    stored.key = null;
    stored.fails = false;
    stored.reads = 0;
  });

  it("is the four characters the machine shows for the same key", async () => {
    // RFC 7638's example thumbprint; the server and Swift suites assert the same pair.
    stored.key = { thumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs" };
    expect(await loadOwnDeviceShortId()).toBe("TSKR");
  });

  it("is left out when the window holds no key, the key cannot be read or is not a thumbprint", async () => {
    expect(await loadOwnDeviceShortId()).toBeNull();
    stored.fails = true;
    expect(await loadOwnDeviceShortId()).toBeNull();
    stored.fails = false;
    stored.key = { thumbprint: "not a thumbprint" };
    expect(await loadOwnDeviceShortId()).toBeNull();
  });

  it("follows the key: a window that signs in or replaces its key shows the new ID", async () => {
    expect(await loadOwnDeviceShortId()).toBeNull();
    stored.key = { thumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs" };
    expect(await loadOwnDeviceShortId()).toBe("TSKR");
    stored.key = { thumbprint: "_wAA_0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1w" };
    expect(await loadOwnDeviceShortId()).toBe("9229");
  });

  it("reads the key once for callers that ask at the same moment", async () => {
    stored.key = { thumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs" };
    expect(await Promise.all([loadOwnDeviceShortId(), loadOwnDeviceShortId()])).toEqual([
      "TSKR",
      "TSKR",
    ]);
    expect(stored.reads).toBe(1);
  });
});
