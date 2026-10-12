// @vitest-environment jsdom

import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface TestToast {
  readonly id: string;
  options: { readonly data?: { readonly onClose?: () => void } };
  open: boolean;
}

const testState = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<ServerProvider>,
  toasts: [] as TestToast[],
  nextToastId: 0,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.providers }));
vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: Symbol("providers"),
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "env-primary" }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./ui/toast", () => ({
  hiddenToastActionProps: {},
  stackedThreadToast: <T,>(options: T) => options,
  toastManager: {
    add: (options: TestToast["options"]) => {
      const toast = { id: `toast-${(testState.nextToastId += 1)}`, options, open: true };
      testState.toasts.push(toast);
      return toast.id;
    },
    update: (id: string, options: TestToast["options"]) => {
      const toast = testState.toasts.find((candidate) => candidate.id === id);
      if (toast) toast.options = options;
    },
    close: (id: string) => {
      const toast = testState.toasts.find((candidate) => candidate.id === id);
      if (toast) toast.open = false;
    },
  },
}));

import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY } from "../providerUpdateDismissal";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

// Each test needs its own notification key: shown keys are remembered per page load.
function codexBehind(latestVersion: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.159.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-09T19:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "0.159.0",
      latestVersion,
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-10-09T19:00:00.000Z",
      message: "Update available.",
    },
  } as ServerProvider;
}

const openToasts = () => testState.toasts.filter((toast) => toast.open);

let rerender: () => void = () => undefined;

function Harness() {
  const [, setTick] = useState(0);
  rerender = () => setTick((tick) => tick + 1);
  return <ProviderUpdatePrimaryNotification />;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  removeLocalStorageItem(PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY);
  testState.toasts = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ProviderUpdatePrimaryNotification", () => {
  it("keeps the update prompt open through StrictMode's dev remount", async () => {
    testState.providers = [codexBehind("0.162.1")];

    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });

    expect(openToasts()).toHaveLength(1);
  });

  it("does not touch the prompt again on unrelated re-renders", async () => {
    testState.providers = [codexBehind("0.162.2")];
    await act(async () => root.render(<Harness />));
    const [prompt] = testState.toasts;
    const options = prompt?.options;

    for (let index = 0; index < 5; index += 1) {
      await act(async () => rerender());
    }

    expect(testState.toasts).toHaveLength(1);
    expect(prompt?.options).toBe(options);
  });

  it("stays dismissed after the user closes the prompt", async () => {
    testState.providers = [codexBehind("0.162.3")];
    await act(async () => root.render(<Harness />));
    const [prompt] = testState.toasts;

    await act(async () => {
      prompt?.options.data?.onClose?.();
      prompt!.open = false;
    });
    await act(async () => rerender());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness />));

    expect(testState.toasts).toHaveLength(1);
    expect(openToasts()).toHaveLength(0);
  });
});
