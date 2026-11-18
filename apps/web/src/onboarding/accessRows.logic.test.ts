import { describe, expect, it } from "vite-plus/test";

import { accessRows, type AccessRowsMachine } from "./accessRows.logic";

const mac = (overrides: Partial<AccessRowsMachine> = {}): AccessRowsMachine => ({
  id: "this-mac",
  own: true,
  platform: "darwin",
  recommended: true,
  computerUseLocal: true,
  fullDiskAccessLocal: true,
  ...overrides,
});
const other = (id: string, overrides: Partial<AccessRowsMachine> = {}): AccessRowsMachine => ({
  id,
  own: false,
  platform: "linux",
  recommended: true,
  ...overrides,
});
const ids = (rows: ReturnType<typeof accessRows>) =>
  rows.map((row) => `${row.id}:${row.machineIds.join("+")}`);

describe("accessRows", () => {
  it.each([
    {
      name: "one Mac in the desktop app, Full access recommended",
      input: { desktopApp: true, machines: [mac()] },
      rows: ["files:this-mac", "browser:this-mac", "mac-apps:this-mac", "full-disk-access:this-mac"],
    },
    {
      name: "one Mac in the desktop app, nothing to recommend",
      input: { desktopApp: true, machines: [mac({ recommended: false })] },
      rows: ["browser:this-mac", "mac-apps:this-mac", "full-disk-access:this-mac"],
    },
    {
      name: "one Mac in a browser tab",
      input: { desktopApp: false, machines: [mac()] },
      rows: ["files:this-mac"],
    },
    {
      name: "one Mac in a browser tab, nothing to recommend: no stage",
      input: { desktopApp: false, machines: [mac({ recommended: false })] },
      rows: [],
    },
    {
      name: "Windows desktop app",
      input: {
        desktopApp: true,
        machines: [
          mac({ id: "pc", platform: "win32", computerUseLocal: false, fullDiskAccessLocal: false }),
        ],
      },
      rows: ["files:pc", "browser:pc"],
    },
    {
      name: "Linux desktop app, nothing to recommend",
      input: {
        desktopApp: true,
        machines: [mac({ id: "box", platform: "linux", recommended: false })],
      },
      rows: ["browser:box"],
    },
    {
      name: "a Mac whose permissions this window cannot read",
      input: {
        desktopApp: true,
        machines: [mac({ computerUseLocal: false, fullDiskAccessLocal: false })],
      },
      rows: ["files:this-mac", "browser:this-mac"],
    },
    {
      name: "three machines in the desktop app, recommended on two",
      input: {
        desktopApp: true,
        machines: [mac(), other("studio"), other("mini", { recommended: false })],
      },
      rows: [
        "files:this-mac+studio",
        "browser:this-mac",
        "mac-apps:this-mac",
        "full-disk-access:this-mac",
      ],
    },
    {
      name: "three machines in a browser tab",
      input: { desktopApp: false, machines: [mac(), other("studio"), other("mini")] },
      rows: ["files:this-mac+studio+mini"],
    },
    {
      name: "the hosted page, other machines only",
      input: { desktopApp: false, machines: [other("studio"), other("mini")] },
      rows: ["files:studio+mini"],
    },
    {
      name: "the desktop app setting up only other machines",
      input: { desktopApp: true, machines: [other("studio"), other("mini", { recommended: false })] },
      rows: ["files:studio"],
    },
  ])("$name", ({ input, rows }) => {
    expect(ids(accessRows(input))).toEqual(rows);
  });

  it.each([
    ["present", true],
    ["absent", false],
    ["unknown", false],
    [undefined, false],
  ] as const)("iPhone Mirroring %s shows the iPhone row: %s", (fact, shown) => {
    const rows = accessRows({
      desktopApp: true,
      machines: [mac(fact === undefined ? {} : { iphoneMirroring: fact })],
    });
    expect(rows.some((row) => row.id === "iphone")).toBe(shown);
    // Full Disk Access stays last.
    expect(rows.at(-1)?.id).toBe("full-disk-access");
  });

  it("never shows the iPhone row in a browser tab", () => {
    expect(
      ids(accessRows({ desktopApp: false, machines: [mac({ iphoneMirroring: "present" })] })),
    ).toEqual(["files:this-mac"]);
  });
});
