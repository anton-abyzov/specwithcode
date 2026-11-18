import { describe, expect, it } from "vite-plus/test";

import { deviceShortIdOfThumbprint } from "./deviceShortId.ts";

/**
 * The vectors the server, the web app and the iPhone all assert (1406 AC-04):
 * a device must read the same ID as the machine shows for it.
 */
const DEVICE_SHORT_ID_VECTORS = [
  // The thumbprint of RFC 7638's example key; its first bytes are 55, 54, 203, 177.
  ["NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", "TSKR"],
  // First bytes 255, 0, 0, 255: both ends of the byte range, and the url-safe characters.
  ["_wAA_0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1w", "9229"],
] as const;

describe("deviceShortIdOfThumbprint (1406)", () => {
  it("gives the shared vectors", () => {
    for (const [thumbprint, id] of DEVICE_SHORT_ID_VECTORS)
      expect(deviceShortIdOfThumbprint(thumbprint)).toBe(id);
  });

  it("uses only characters codes are made of, never 0, 1, I, L or O", () => {
    const all = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const first of all)
      for (const second of all)
        expect(
          deviceShortIdOfThumbprint(`${first}${second}${first}${second}${first}${second}`),
        ).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  });

  it("tells two keys apart and stays the same for one key", () => {
    const a = deviceShortIdOfThumbprint("z3tKzoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const b = deviceShortIdOfThumbprint("4LRcG8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(a).not.toBe(b);
    expect(deviceShortIdOfThumbprint(" z3tKzoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ")).toBe(a);
  });

  it("gives nothing for text that is not a thumbprint", () => {
    for (const text of ["", "abc", "not a thumbprint", "abc+/=xyz"])
      expect(deviceShortIdOfThumbprint(text)).toBeUndefined();
  });
});
