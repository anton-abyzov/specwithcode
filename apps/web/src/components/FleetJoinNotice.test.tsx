import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  id: 0,
  primary: true,
  seen: null as string | null,
  snapshot: null as unknown,
  add: vi.fn((_notice: unknown) => "notice"),
  save: vi.fn(),
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => (state.primary ? `env-${state.id}` : null),
}));
vi.mock("../studio/fleet", () => ({ useStudioFleet: () => ({ snapshot: state.snapshot }) }));
vi.mock("../i18n", () => ({
  useTx: () => (english: string, values?: Record<string, string>) =>
    english.replace(/\{(\w+)\}/gu, (_match, name: string) => values?.[name] ?? ""),
}));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => state.seen,
  setLocalStorageItem: (...args: unknown[]) => state.save(...args),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.add } }));

import { FleetJoinNotice } from "./FleetJoinNotice";

const recent = () => new Date(Date.now() - 60_000).toISOString();
let renderer: ReactTestRenderer;
beforeEach(() => {
  state.id++;
  state.primary = true;
  state.seen = null;
  state.snapshot = null;
  vi.clearAllMocks();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
async function render() {
  await act(async () => {
    renderer = create(<FleetJoinNotice />);
  });
}

it("says a machine joined, with nothing to press, and remembers it", async () => {
  const joinedAt = recent();
  state.snapshot = {
    machines: [{ id: "m5" }],
    accountJoins: [{ id: "m5", label: "MacBook Pro", joinedAt }],
  };
  await render();
  expect(state.add).toHaveBeenCalledTimes(1);
  const notice = state.add.mock.calls[0]![0] as Record<string, unknown>;
  expect(notice).toMatchObject({ type: "info", title: "MacBook Pro joined", timeout: 0 });
  expect(notice.description).toContain("Nothing to accept");
  expect(notice).not.toHaveProperty("actionProps");
  expect(state.save.mock.calls[0]?.slice(0, 2)).toEqual([
    `studio:fleet-account-joins-seen:v1:env-${state.id}`,
    joinedAt,
  ]);
  // The fleet is read again every few seconds: the same join is not said twice.
  await act(async () => renderer.update(<FleetJoinNotice />));
  expect(state.add).toHaveBeenCalledTimes(1);
});

it("stays quiet for a join this browser already showed, and with no joins", async () => {
  const joinedAt = recent();
  state.seen = joinedAt;
  state.snapshot = {
    machines: [{ id: "m5" }],
    accountJoins: [{ id: "m5", label: "MacBook Pro", joinedAt }],
  };
  await render();
  state.snapshot = { machines: [{ id: "m5" }] };
  await act(async () => renderer.update(<FleetJoinNotice />));
  expect(state.add).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});

it("shows nothing before this app knows its own machine", async () => {
  state.primary = false;
  state.snapshot = {
    machines: [{ id: "m5" }],
    accountJoins: [{ id: "m5", label: "MacBook Pro", joinedAt: recent() }],
  };
  await render();
  expect(state.add).not.toHaveBeenCalled();
});
