// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({ live: null as EnvironmentThreadShell | null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.live }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./projects", () => ({ environmentProjects: {} }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("./shell", () => ({ allEnvironmentProjectSnapshotsReadyAtom: {}, allEnvironmentShellsBootstrappedAtom: {} }));
vi.mock("./threads", () => ({ environmentThreadDetails: {}, environmentThreadShells: { threadShellAtom: () => ({}) } }));
vi.mock("./waitForAtomValue", () => ({ waitForAtomValue: () => {} }));
import { useThreadShell } from "./entities";
import { SelectedThreadShell } from "./selectedThreadShell";

it("lets embedded history consumers read a selected shell missing from the active index and switch to live state", async () => {
  const selected = { id: "history", environmentId: "host", deletedAt: null, archivedAt: "2026-10-14" } as EnvironmentThreadShell;
  const ref = { environmentId: "host", threadId: "history" } as ScopedThreadRef;
  let observed: EnvironmentThreadShell | null = null;
  function DetailConsumer() { observed = useThreadShell(ref); return <span>{observed?.id ?? "No active thread"}</span>; }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(<SelectedThreadShell value={selected}><DetailConsumer /></SelectedThreadShell>));
    expect(observed).toBe(selected);
    expect(container.textContent).toBe("history");
    state.live = { ...selected, archivedAt: null };
    await act(() => root.render(<SelectedThreadShell value={selected}><DetailConsumer /></SelectedThreadShell>));
    expect(observed).toBe(state.live);
  } finally { await act(() => root.unmount()); state.live = null; }
});
