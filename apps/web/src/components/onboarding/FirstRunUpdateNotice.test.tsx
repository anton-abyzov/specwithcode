// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DesktopUpdateState } from "@specweave-studio/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  state: null as DesktopUpdateState | null,
  serviceRun: null as unknown,
  restart: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => mocks.state }));
vi.mock("../../state/serviceUpdate", () => ({ useStudioServiceUpdateState: () => null }));
vi.mock("../serviceUpdateRunView", () => ({ liveServiceUpdateRun: () => mocks.serviceRun }));
vi.mock("../sidebar/restartToUpdateRequests", () => ({ requestRestartToUpdate: mocks.restart }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { FirstRunUpdateNotice, firstRunUpdateView } from "./FirstRunUpdateNotice";

const idle: DesktopUpdateState = {
  enabled: true,
  status: "up-to-date",
  channel: "latest",
  currentVersion: "1.0.100",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const available = { ...idle, status: "available", availableVersion: "1.0.136" } as const;
const downloaded = {
  ...available,
  status: "downloaded",
  downloadedVersion: "1.0.136",
} as const;

let root: Root;
let container: HTMLDivElement;
const downloadUpdate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = null;
  mocks.serviceRun = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("desktopBridge", { downloadUpdate });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === label);

it("offers nothing while the app is current or an Update now run is going", () => {
  expect(firstRunUpdateView(null, false)).toBeNull();
  expect(firstRunUpdateView(idle, false)).toBeNull();
  expect(firstRunUpdateView(downloaded, true)).toBeNull();
});

it("offers the download, its progress and the install in turn", () => {
  expect(firstRunUpdateView(available, false)).toEqual({ kind: "download", version: "1.0.136" });
  expect(
    firstRunUpdateView({ ...available, status: "downloading", downloadPercent: 42.7 }, false),
  ).toEqual({ kind: "downloading", percent: 42.7 });
  expect(firstRunUpdateView(downloaded, false)).toEqual({
    kind: "install",
    version: "1.0.136",
    checking: false,
  });
});

it("keeps a downloaded update offered, but not pressable, while a check runs", async () => {
  const checking = { ...downloaded, status: "checking" } as const;
  expect(firstRunUpdateView(checking, false)).toEqual({
    kind: "install",
    version: "1.0.136",
    checking: true,
  });
  mocks.state = checking;
  await act(async () => root.render(<FirstRunUpdateNotice />));
  expect(button("Checking…")?.disabled).toBe(true);
  expect(button("Restart to update")).toBeUndefined();
});

it("downloads an available update from setup", async () => {
  mocks.state = available;
  downloadUpdate.mockResolvedValue({ accepted: true, completed: true, state: available });
  await act(async () => root.render(<FirstRunUpdateNotice />));
  expect(container.textContent).toContain("SpecWithCode 1.0.136 is available.");
  await act(async () => button("Download update")!.click());
  expect(downloadUpdate).toHaveBeenCalledOnce();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("installs a downloaded update through the same Restart to update path", async () => {
  mocks.state = downloaded;
  mocks.restart.mockReturnValue(true);
  await act(async () => root.render(<FirstRunUpdateNotice />));
  expect(container.textContent).toContain("SpecWithCode 1.0.136 is ready to install.");
  await act(async () => button("Restart to update")!.click());
  expect(mocks.restart).toHaveBeenCalledOnce();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("says to quit and reopen when no Restart to update control is mounted", async () => {
  mocks.state = downloaded;
  mocks.restart.mockReturnValue(false);
  await act(async () => root.render(<FirstRunUpdateNotice />));
  await act(async () => button("Restart to update")!.click());
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Quit and reopen SpecWithCode to install it." }),
  );
});
