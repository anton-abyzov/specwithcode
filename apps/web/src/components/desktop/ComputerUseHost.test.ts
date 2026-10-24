import { expect, it } from "vite-plus/test";

import { computerUseHostInput } from "./ComputerUseHost";

type Bridge = NonNullable<Window["desktopBridge"]>;
const bridge = (fields: Partial<Bridge>) => fields as Bridge;

it("offers the macOS app as a host that runs actions", () => {
  expect(
    computerUseHostInput(
      bridge({
        runComputerUseAction: async () => ({}) as never,
        getClientPlatform: () => "darwin",
      }),
    ),
  ).toEqual({ label: "SpecWithCode desktop app", platform: "macos" });
});

it.each([
  ["win32", "windows"],
  ["linux", "linux"],
])("connects on %s with its platform so agents hear computer use is unsupported", (node, host) => {
  expect(computerUseHostInput(bridge({ getClientPlatform: () => node }))).toEqual({
    label: "SpecWithCode desktop app",
    platform: host,
  });
});

it("offers nothing outside the desktop app or from a macOS preload without the runner", () => {
  expect(computerUseHostInput(undefined)).toBeNull();
  expect(computerUseHostInput(bridge({ getClientPlatform: () => "darwin" }))).toBeNull();
});
