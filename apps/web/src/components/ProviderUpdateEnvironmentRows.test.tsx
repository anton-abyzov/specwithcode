import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";

import type {
  LocalEnvironmentUpdateGroup,
  ProviderUpdateCandidate,
  ProviderUpdateRowStatus,
} from "./ProviderUpdateLaunchNotification.logic";

const testState = vi.hoisted(() => ({
  groups: [] as LocalEnvironmentUpdateGroup[],
  permittedEnvironmentIds: new Set<EnvironmentId>(),
  updateProvider: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("~/state/session", () => ({
  readEnvironmentScope: (environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
    scope === AuthProvidersManageScope && testState.permittedEnvironmentIds.has(environmentId),
  useEnvironmentScopeAccess: (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null &&
    scope === AuthProvidersManageScope &&
    testState.permittedEnvironmentIds.has(environmentId)
      ? "granted"
      : "denied",
  providerManageBlockedText: (access: string) =>
    access === "granted" ? null : "This connection cannot manage provider accounts.",
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useLocalEnvironmentUpdateGroups: () => ({
    groups: testState.groups,
    isAnySettling: false,
  }),
}));

import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";

const environmentId = "env-wsl" as EnvironmentId;
const pendingExpiryMs = 6 * 60_000;

function provider(updateStatus?: "succeeded"): ServerProvider {
  const result: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex-wsl"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: updateStatus ? "1.1.0" : "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-26T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: updateStatus ? "current" : "behind_latest",
      currentVersion: updateStatus ? "1.1.0" : "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-06-26T12:00:00.000Z",
      message: updateStatus ? "Up to date." : "Update available.",
    },
  };

  return updateStatus
    ? {
        ...result,
        updateState: {
          status: updateStatus,
          startedAt: "2026-06-26T12:00:00.000Z",
          finishedAt: "2026-06-26T12:00:01.000Z",
          message: "Provider updated.",
          output: null,
        },
      }
    : result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type RowElement = ReactElement<{
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
  readonly onUpdateAnyway?: (() => void) | undefined;
}>;

function renderRow(): RowElement {
  hooks.beginRender();
  const output = ProviderUpdateEnvironmentRows({}) as ReactElement<{
    readonly children: RowElement | RowElement[];
  }>;
  const children = output.props.children;
  return Array.isArray(children) ? children[0]! : children;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProviderUpdateEnvironmentRows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.reset();
    testState.permittedEnvironmentIds.clear();
    testState.permittedEnvironmentIds.add(environmentId);
    testState.updateProvider.mockReset();
    const candidate = provider() as ProviderUpdateCandidate;
    testState.groups = [
      {
        environmentId,
        label: "WSL",
        isPrimary: false,
        isSettling: false,
        candidates: [candidate],
        providers: [candidate],
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a successor pending when an expired request resolves late, then shows its success", async () => {
    const firstRequest =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    const successorRequest =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    testState.updateProvider
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(successorRequest.promise);

    renderRow().props.onUpdate();
    expect(renderRow().props.status.kind).toBe("loading");

    await vi.advanceTimersByTimeAsync(pendingExpiryMs);
    expect(renderRow().props.status.kind).toBe("failed");

    renderRow().props.onUpdate();
    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
    expect(renderRow().props.status.kind).toBe("loading");

    firstRequest.resolve(AsyncResult.success({ providers: [provider("succeeded")] }));
    await flushPromises();

    expect(renderRow().props.status.kind).toBe("loading");

    successorRequest.resolve(AsyncResult.success({ providers: [provider("succeeded")] }));
    await flushPromises();

    expect(renderRow().props.status.kind).toBe("success");
  });

  it("offers Update anyway after an in-use refusal and retries with force", async () => {
    const refused: ServerProvider = {
      ...provider(),
      updateState: {
        status: "failed",
        startedAt: "2026-06-26T12:00:00.000Z",
        finishedAt: "2026-06-26T12:00:01.000Z",
        message: "codex is running (pid 7: codex app-server).",
        output: null,
        inUse: true,
      },
    };
    testState.updateProvider
      .mockResolvedValueOnce(AsyncResult.success({ providers: [refused] }))
      .mockResolvedValueOnce(AsyncResult.success({ providers: [provider("succeeded")] }));

    expect(renderRow().props.onUpdateAnyway).toBeUndefined();
    renderRow().props.onUpdate();
    await flushPromises();
    const failed = renderRow();
    expect(failed.props.status.kind).toBe("failed");
    expect(failed.props.status.text).toContain("pid 7");
    expect(testState.updateProvider.mock.calls[0]?.[0].input.force).toBeUndefined();

    failed.props.onUpdateAnyway!();
    await flushPromises();
    expect(testState.updateProvider.mock.calls[1]?.[0].input).toMatchObject({ force: true });
    expect(renderRow().props.status.kind).toBe("success");
  });

  it("Update anyway forces only the candidates refused as in use", async () => {
    const failedState = (message: string, inUse?: true) => ({
      status: "failed" as const,
      startedAt: "2026-06-26T12:00:00.000Z",
      finishedAt: "2026-06-26T12:00:01.000Z",
      message,
      output: null,
      ...(inUse ? { inUse } : {}),
    });
    const codex = provider() as ProviderUpdateCandidate;
    const claude = {
      ...provider(),
      instanceId: ProviderInstanceId.make("claude-wsl"),
      driver: ProviderDriverKind.make("claudeAgent"),
    } as ProviderUpdateCandidate;
    testState.groups = [
      {
        environmentId,
        label: "WSL",
        isPrimary: false,
        isSettling: false,
        candidates: [codex, claude],
        providers: [codex, claude],
      },
    ];
    testState.updateProvider.mockImplementation(
      async ({ input }: { input: { instanceId: string; force?: boolean } }) =>
        AsyncResult.success({
          providers: [
            input.instanceId === "codex-wsl"
              ? input.force
                ? { ...provider("succeeded") }
                : { ...codex, updateState: failedState("codex is running (pid 7: codex).", true) }
              : { ...claude, updateState: failedState("npm exited with code 1.") },
          ],
        }),
    );

    renderRow().props.onUpdate();
    await flushPromises();
    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
    for (const call of testState.updateProvider.mock.calls) {
      expect(call[0].input.force).toBeUndefined();
    }

    const failed = renderRow();
    expect(failed.props.status.kind).toBe("failed");
    failed.props.onUpdateAnyway!();
    await flushPromises();

    expect(testState.updateProvider).toHaveBeenCalledTimes(3);
    expect(testState.updateProvider.mock.calls[2]?.[0].input).toEqual({
      provider: "codex",
      instanceId: "codex-wsl",
      force: true,
    });
    expect(
      testState.updateProvider.mock.calls.filter(
        (call) => call[0].input.instanceId === "claude-wsl" && call[0].input.force,
      ),
    ).toHaveLength(0);
  });
});
