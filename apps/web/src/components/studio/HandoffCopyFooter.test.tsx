// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HandoffCopyFooter } from "./HandoffCopyFooter";
import { copyStatus } from "./HandoffFolderCopy.testkit";
vi.mock("./HandoffCopyDone", () => ({
  HandoffCopyDoneActions: () => null,
  HandoffCopyFailedActions: () => null,
}));
vi.mock("./ProjectMoveOptions", () => ({ useProjectMoveDialog: () => null }));
let host: HTMLDivElement;
let root: Root;
const apply = vi.fn();
const replace = vi.fn();
const base = (): ComponentProps<typeof HandoffCopyFooter> => ({
  stage: "preview",
  error: null,
  busy: false,
  working: false,
  pending: null,
  copy: copyStatus("previewed", {
    totals: { filesToMove: 1, bytesToMove: 10, bytesPresent: 0, decisionsNeeded: 0 },
  }) as never,
  machine: "m3" as never,
  mode: "copy-only",
  targetLabel: "M3",
  auto: false,
  chooseFirst: false,
  selection: ["tracked"],
  setupBlocked: false,
  replaced: null,
  approveLabel: "Copy to M3",
  secretsUnconfirmed: false,
  failedBeforeApply: false,
  undoPreview: null,
  copyAgain: false,
  contextTransferred: false,
  link: null,
  transferRecovery: false,
  sourceDropped: false,
  onCancelMeasure: vi.fn(),
  onResume: vi.fn(),
  onMeasure: vi.fn(),
  onPlan: vi.fn(),
  onStop: vi.fn(),
  onReplaceAll: replace,
  onApply: apply,
  onCopyAgain: vi.fn(),
  onRetry: vi.fn(),
  onUndo: vi.fn(),
  onEndSourceHold: vi.fn(),
  onTransfer: null,
  onOpen: vi.fn(),
  onLink: vi.fn(),
  onStartNew: vi.fn(),
  onChangeSetup: vi.fn(),
});
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
const render = (overrides: Partial<ComponentProps<typeof HandoffCopyFooter>> = {}) =>
  act(async () => root.render(<HandoffCopyFooter {...base()} {...overrides} />));
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it.each([
  [{ busy: true }, "Wait for the current check"],
  [{ sourceChanged: true }, "The source changed"],
  [{ secretsUnconfirmed: true }, "Confirm sending"],
  [{ copy: { ...base().copy, disk: { needed: 100, available: 0 } } }, "more disk space"],
  [{ copy: { ...base().copy, totals: null } }, "comparison totals"],
] as const)("explains and blocks copying for %j", async (overrides, reason) => {
  await render(overrides as never);
  expect(button("Copy to M3").disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(reason);
  button("Copy to M3").click();
  expect(apply).not.toHaveBeenCalled();
  expect(
    document.getElementById(button("Copy to M3").getAttribute("aria-describedby")!)?.textContent,
  ).toContain(reason);
});
it("keeps Replace available while individual decisions remain", async () => {
  await render({
    replaced: "Some files",
    copy: { ...base().copy, totals: { ...base().copy!.totals!, decisionsNeeded: 3 } } as never,
  });
  expect(button("Copy with my choices").disabled).toBe(true);
  expect(button("Replace everything").disabled).toBe(false);
  expect(host.textContent).toContain("3 remaining items");
  button("Replace everything").click();
  expect(replace).toHaveBeenCalledOnce();
});
it("enables Copy when ready and explains readiness", async () => {
  await render();
  expect(button("Copy to M3").disabled).toBe(false);
  expect(host.textContent).toContain("Ready to copy");
  button("Copy to M3").click();
  expect(apply).toHaveBeenCalledOnce();
});
it("blocks both actions for disk refusal even after choices are resolved", async () => {
  await render({
    replaced: "Some files",
    copy: { ...base().copy, disk: { needed: 100, available: 0 } } as never,
  });
  expect(button("Copy with my choices").disabled).toBe(true);
  expect(button("Replace everything").disabled).toBe(true);
});
