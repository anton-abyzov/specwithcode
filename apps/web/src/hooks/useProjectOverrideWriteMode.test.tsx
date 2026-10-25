import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@specweave-studio/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ConfigLike = {
  environment: { capabilities: { projectSettingsOverrideChanges?: boolean } };
} | null;
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  config: null as Atom.Writable<unknown> | null,
}));

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@specweave-studio/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => undefined }),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    updateSettings: Symbol("updateSettings"),
    configValueAtom: () => state.config!,
  },
  primaryServerSettingsAtom: undefined,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/themePalette", () => ({}));
vi.mock("./useTheme", () => ({}));

import { useProjectOverrideWriteMode } from "./useSettings";

const environmentId = EnvironmentId.make("machine");
let renderer: ReactTestRenderer | undefined;

function Probe() {
  return <output>{String(useProjectOverrideWriteMode(environmentId))}</output>;
}

async function renderedMode() {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <Probe />
      </RegistryContext.Provider>,
    );
  });
  return renderer!.root.findByType("output").props.children as string;
}

function loadConfig(config: ConfigLike) {
  state.registry!.set(state.config!, config);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
  state.config = Atom.make<unknown>(null);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});

describe("useProjectOverrideWriteMode", () => {
  it("is null until the machine's config loads, so no writer saves from the defaults", async () => {
    expect(await renderedMode()).toBe("null");
  });

  it("saves key by key on a server that applies per-key changes", async () => {
    loadConfig({ environment: { capabilities: { projectSettingsOverrideChanges: true } } });
    expect(await renderedMode()).toBe("per-key");
  });

  it("replaces whole entries on a loaded server without per-key changes", async () => {
    loadConfig({ environment: { capabilities: {} } });
    expect(await renderedMode()).toBe("entry");
  });
});
