import { DEFAULT_SERVER_SETTINGS, folderCopyLanGateOpen } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { lanGatedSettingsPatch } from "./serverSettings.ts";

describe("the local-network copy setting (1334 S-11)", () => {
  it("is off by default", () => {
    expect(DEFAULT_SERVER_SETTINGS.folderCopyOverLan).toBe(false);
  });

  it("drops a write that turns it on while the gate is closed, on every operating system", () => {
    for (const platform of ["darwin", "win32", "linux", "freebsd"]) {
      expect(folderCopyLanGateOpen(platform), platform).toBe(false);
      expect(
        lanGatedSettingsPatch({ folderCopyOverLan: true, other: 1 }, platform),
        platform,
      ).toEqual({ other: 1 });
    }
  });

  it("always lets it be turned off, and leaves other settings alone", () => {
    expect(lanGatedSettingsPatch({ folderCopyOverLan: false }, "darwin")).toEqual({
      folderCopyOverLan: false,
    });
    const untouched: { folderCopyOverLan?: boolean; other: number } = { other: 1 };
    expect(lanGatedSettingsPatch(untouched, "darwin")).toBe(untouched);
  });
});
