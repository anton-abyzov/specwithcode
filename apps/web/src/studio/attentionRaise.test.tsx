import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentIds: ["env-laptop", "env-desk"] as string[],
  unreachable: new Set<string>(),
  primary: "env-laptop" as string | null,
  reads: [] as string[],
  cached: new Map<string, unknown>(),
}));

vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => state.environmentIds,
  usePrimaryEnvironmentId: () => state.primary,
  useUnreachableEnvironmentIds: () => state.unreachable,
}));
vi.mock("../lib/backgroundActivityReporter", () => ({
  backgroundActivityClientId: () => "client-laptop",
  appClientId: (clientId: string) => clientId.split(":")[0],
}));
vi.mock("../notificationTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notificationTarget")>()),
  readNotificationTarget: (environmentId: string) => {
    state.reads.push(environmentId);
    return Promise.resolve(state.cached.get(environmentId));
  },
  cachedNotificationTarget: (environmentId: string) => state.cached.get(environmentId),
}));

import {
  TARGET_REFRESH_MS,
  __targetPollingActiveForTests,
  useAttentionRaise,
  type AttentionRaise,
} from "./attentionRaise";

const probe: { raise?: AttentionRaise } = {};
const renderers: ReactTestRenderer[] = [];
let visibility: DocumentVisibilityState = "visible";
const documentEvents = new EventTarget();

function Probe() {
  const raise = useAttentionRaise();
  useLayoutEffect(() => {
    probe.raise = raise;
  });
  return null;
}

async function mount() {
  await act(() => {
    renderers.push(create(<Probe />));
  });
}

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(() => {
    documentEvents.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  });
  Object.assign(state, {
    environmentIds: ["env-laptop", "env-desk"],
    unreachable: new Set<string>(),
    primary: "env-laptop",
    reads: [],
    cached: new Map(),
  });
});

afterEach(async () => {
  await act(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  delete probe.raise;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useAttentionRaise", () => {
  it("judges the owner machine reachable as popups do: a machine still connecting counts", async () => {
    // The desk elected another app. Its connection is still being set up, which
    // the catalog does not call unreachable, so the desk's own app counts it.
    state.cached.set("env-desk", {
      status: "known",
      target: { clientId: "client-desk", reason: "foreground" },
      ownerAppConnected: true,
    });
    await mount();
    expect(probe.raise?.({ environmentId: "env-desk" }, "env-desk")).toBe(false);

    state.unreachable = new Set(["env-desk"]);
    await act(() => renderers[0]?.update(<Probe />));
    expect(probe.raise?.({ environmentId: "env-desk" }, "env-desk")).toBe(true);
    // A machine this app does not know cannot raise it either.
    expect(probe.raise?.({ environmentId: "env-desk" }, "env-unknown")).toBe(true);
  });

  it("reads every machine once per interval however many surfaces count", async () => {
    await mount();
    await mount();
    await mount();
    expect(state.reads.toSorted()).toEqual(["env-desk", "env-laptop"]);
    state.reads = [];
    await act(() => vi.advanceTimersByTimeAsync(TARGET_REFRESH_MS));
    expect(state.reads.toSorted()).toEqual(["env-desk", "env-laptop"]);
  });

  it("stops reading while the window is hidden and reads again when it shows", async () => {
    await mount();
    expect(__targetPollingActiveForTests()).toBe(true);
    await setVisibility("hidden");
    expect(__targetPollingActiveForTests()).toBe(false);
    state.reads = [];
    await act(() => vi.advanceTimersByTimeAsync(TARGET_REFRESH_MS * 4));
    expect(state.reads).toEqual([]);
    await setVisibility("visible");
    expect(state.reads.toSorted()).toEqual(["env-desk", "env-laptop"]);
    expect(__targetPollingActiveForTests()).toBe(true);
  });

  it("reads nothing with one machine, and stops once the last surface goes", async () => {
    state.environmentIds = ["env-laptop"];
    await mount();
    expect(state.reads).toEqual([]);
    expect(__targetPollingActiveForTests()).toBe(false);

    state.environmentIds = ["env-laptop", "env-desk"];
    await act(() => renderers[0]?.update(<Probe />));
    expect(__targetPollingActiveForTests()).toBe(true);
    await act(() => {
      for (const renderer of renderers.splice(0)) renderer.unmount();
    });
    expect(__targetPollingActiveForTests()).toBe(false);
  });
});
