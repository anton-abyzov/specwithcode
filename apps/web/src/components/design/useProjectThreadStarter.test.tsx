// @vitest-environment jsdom
import { scopedThreadKey, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Each orchestration command records what it was sent; nothing reaches a server.
const commands = vi.hoisted(() => ({
  startTurn: [] as unknown[],
  create: [] as unknown[],
  createFails: null as string | null,
}));
const schedule = vi.hoisted(() => vi.fn());

vi.mock("~/state/threads", () => ({
  threadEnvironment: { startTurn: "startTurn", create: "create" },
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: "startTurn" | "create") => async (value: unknown) => {
    commands[command].push(value);
    if (command === "create" && commands.createFails !== null)
      return AsyncResult.failure(Cause.fail(new Error(commands.createFails)));
    return AsyncResult.success(undefined);
  },
}));
vi.mock("~/lib/durableComposerDraftBindings", () => ({
  durableComposerDrafts: { schedule },
  durableTargetForStoreKey: (storeKey: string) => ({ environmentId: "env-a", key: storeKey }),
  snapshotOfThreadDraft: (draft: { prompt: string } | undefined) => ({
    prompt: draft?.prompt ?? "",
    attachments: [],
  }),
}));

const { useComposerDraftStore } = await import("~/composerDraftStore");
const { NO_PROVIDER_MESSAGE } = await import("./projectThread");
const { useProjectThreadStarter } = await import("./useProjectThreadStarter");

const environmentId = "env-a" as EnvironmentId;
const threadId = "t-1" as ThreadId;
const ready = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as ModelSelection;
const waiting = { instanceId: "codex", model: "gpt-6" } as ModelSelection;
const brief = "Design from code in Web app: A matchday settings page";
const storeKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

let container: HTMLDivElement;
let root: Root;
let start: ReturnType<typeof useProjectThreadStarter>;

function Harness({ onReady }: { onReady: (next: typeof start) => void }) {
  const starter = useProjectThreadStarter();
  useEffect(() => onReady(starter), [onReady, starter]);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commands.startTurn = [];
  commands.create = [];
  commands.createFails = null;
  schedule.mockClear();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <Harness
        onReady={(next) => {
          start = next;
        }}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const request = (model: ModelSelection | null, waitingModel: ModelSelection | null) => ({
  environmentId,
  projectId: "web" as ProjectId,
  threadId,
  title: "A matchday settings page",
  message: { text: brief, images: [] },
  runtimeMode: "full-access" as const,
  model,
  waitingModel,
});

describe("useProjectThreadStarter", () => {
  it("creates the thread with no turn and holds the brief in its composer", async () => {
    expect(await start(request(null, waiting))).toEqual({ ok: true, started: false });
    // No turn: nothing goes through startTurn (message.dispatch), only thread.create.
    expect(commands.startTurn).toEqual([]);
    expect(commands.create).toEqual([
      {
        environmentId,
        input: {
          threadId,
          projectId: "web",
          title: "A matchday settings page",
          modelSelection: waiting,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: expect.any(String),
        },
      },
    ]);
    expect(useComposerDraftStore.getState().draftsByThreadKey[storeKey]?.prompt).toBe(brief);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(
      { environmentId, key: storeKey },
      { prompt: brief, attachments: [] },
    );
  });

  it("launches on a ready model exactly as before", async () => {
    expect(await start(request(ready, waiting))).toEqual({ ok: true, started: true });
    expect(commands.create).toEqual([]);
    expect(commands.startTurn).toEqual([
      {
        environmentId,
        input: {
          threadId,
          message: { messageId: expect.any(String), role: "user", text: brief, attachments: [] },
          modelSelection: ready,
          titleSeed: "A matchday settings page",
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: "start",
          bootstrap: {
            createThread: {
              projectId: "web",
              title: "A matchday settings page",
              modelSelection: ready,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: expect.any(String),
            },
          },
        },
      },
    ]);
    expect(useComposerDraftStore.getState().draftsByThreadKey[storeKey]).toBeUndefined();
  });

  it("refuses with no model to record and sends nothing", async () => {
    expect(await start(request(null, null))).toEqual({ ok: false, message: NO_PROVIDER_MESSAGE });
    expect([...commands.startTurn, ...commands.create]).toEqual([]);
    expect(useComposerDraftStore.getState().draftsByThreadKey[storeKey]).toBeUndefined();
  });

  it("holds nothing when the thread was not created", async () => {
    commands.createFails = "This connection cannot change threads or projects.";
    expect(await start(request(null, waiting))).toEqual({
      ok: false,
      message: "This connection cannot change threads or projects.",
    });
    expect(commands.startTurn).toEqual([]);
    expect(useComposerDraftStore.getState().draftsByThreadKey[storeKey]).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });
});
