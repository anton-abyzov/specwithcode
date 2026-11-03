import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The real hooks over a real atom registry: only where the primary server's
// config comes from, and whether the app is hosted, are stand-ins.
const state = vi.hoisted(() => ({
  primaryConfig: null as unknown as Atom.Writable<{ settings: { aideEnabled: boolean } } | null>,
  primary: { environmentId: "primary" } as { environmentId: string } | null,
  hosted: false,
}));

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@specweave-studio/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({}),
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@specweave-studio/contracts");
  state.primaryConfig = Atom.make<{ settings: { aideEnabled: boolean } } | null>(null).pipe(
    Atom.keepAlive,
  );
  return {
    serverEnvironment: { updateSettings: Symbol("updateSettings") },
    primaryServerConfigAtom: state.primaryConfig,
    primaryServerSettingsAtom: Atom.make((get) => ({
      ...DEFAULT_SERVER_SETTINGS,
      ...get(state.primaryConfig)?.settings,
    })),
  };
});
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => state.primary,
}));
vi.mock("~/hostedPairing", () => ({ isHostedStaticApp: () => state.hosted }));
vi.mock("~/themePalette", () => ({}));
vi.mock("./useTheme", () => ({}));

import { useAideEnabled, useAideSettingSettled } from "./useSettings";

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
let seen: { enabled: boolean; settled: boolean } | null = null;

function Probe() {
  seen = { enabled: useAideEnabled(), settled: useAideSettingSettled() };
  return null;
}

async function render() {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  registry = AtomRegistry.make();
  state.primary = { environmentId: "primary" };
  state.hosted = false;
  seen = null;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("useAideSettingSettled", () => {
  it("is not settled while the primary server's settings are still on their way", async () => {
    await render();
    // Off here only means "not loaded yet": nothing may be sent away for it.
    expect(seen).toEqual({ enabled: false, settled: false });
  });

  it("settles once the primary's settings arrive, with the saved value", async () => {
    await render();
    await act(async () => {
      registry.set(state.primaryConfig, {
        settings: { ...DEFAULT_SERVER_SETTINGS, aideEnabled: true },
      });
    });
    expect(seen).toEqual({ enabled: true, settled: true });
  });

  it("shows Aide when the primary's settings never saved a choice", async () => {
    registry.set(state.primaryConfig, { settings: { ...DEFAULT_SERVER_SETTINGS } });
    await render();
    expect(seen).toEqual({ enabled: true, settled: true });
  });

  it("settles as off when the primary's settings arrive with Aide off", async () => {
    registry.set(state.primaryConfig, {
      settings: { ...DEFAULT_SERVER_SETTINGS, aideEnabled: false },
    });
    await render();
    expect(seen).toEqual({ enabled: false, settled: true });
  });

  it("is settled and off at once where there is no primary to wait for", async () => {
    state.primary = null;
    state.hosted = true;
    await render();
    expect(seen).toEqual({ enabled: false, settled: true });
  });
});
