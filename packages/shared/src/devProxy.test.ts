import { describe, expect, it } from "vite-plus/test";

import { DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES, DEV_PROXIED_PATH_PREFIXES } from "./devProxy.ts";

describe("dev proxy", () => {
  it("forwards every backend path with the browser's Host, so Origin and Host match", () => {
    // The server lets a cookie open /ws or change state through /api only from
    // the origin the page was opened at; a rewritten Host fails that check.
    for (const prefix of DEV_PROXIED_PATH_PREFIXES) {
      expect(DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has(prefix)).toBe(true);
    }
  });
});
