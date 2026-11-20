import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shell: null as null | { source: { purpose?: "advisor" } },
  capability: true as boolean | undefined,
  settings: {} as object | null,
}));

vi.mock("../../state/entities", () => ({ useThreadShell: () => state.shell }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: {
      environment: {
        capabilities: state.capability === undefined ? {} : { advisor: state.capability },
      },
      settings: state.settings,
    },
  }),
}));

import { useThreadAdvisorRowAvailable } from "./threadAdvisorAvailability";

const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;

function available(ref: typeof threadRef | null): boolean {
  let value: boolean | undefined;
  function Probe() {
    value = useThreadAdvisorRowAvailable(ref);
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return value!;
}

beforeEach(() => {
  state.shell = { source: {} };
  state.capability = true;
  state.settings = {};
});

describe("useThreadAdvisorRowAvailable", () => {
  it("is true for a saved thread on a machine that advertises the advisor", () => {
    expect(available(threadRef)).toBe(true);
  });

  it("is false for a draft, an older server, an advisor child or an unread shell", () => {
    expect(available(null)).toBe(false);
    state.capability = undefined;
    expect(available(threadRef)).toBe(false);
    state.capability = true;
    state.shell = { source: { purpose: "advisor" } };
    expect(available(threadRef)).toBe(false);
    state.shell = null;
    expect(available(threadRef)).toBe(false);
    state.shell = { source: {} };
    state.settings = null;
    expect(available(threadRef)).toBe(false);
  });
});
