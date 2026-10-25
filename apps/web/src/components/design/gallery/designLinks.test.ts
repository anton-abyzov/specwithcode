import { describe, expect, it } from "vite-plus/test";

import { designLinkReach } from "./designLinks";

describe("designLinkReach", () => {
  it("does not promise paired devices for a loopback link", () => {
    for (const link of [
      "http://127.0.0.1:8319/design/p%3Aweb%3Ad_1",
      "http://localhost:8319/design/x",
      "http://[::1]:8319/design/x",
    ]) {
      const reach = designLinkReach(link);
      expect(reach.loopback).toBe(true);
      expect(reach.text).toBe(
        "This link opens on this computer only. On a paired device, open the design from SpecWithCode there.",
      );
      // On a paired device the loopback address is that device's own, and the server may not be a Mac.
      expect(reach.text).not.toMatch(/Mac|after you pair|your paired devices/);
    }
  });

  it("keeps the paired-devices copy for a reachable host", () => {
    expect(designLinkReach("https://studio.tail1234.ts.net/design/x")).toEqual({
      loopback: false,
      text: "Works on this Mac and your paired devices.",
    });
  });
});
