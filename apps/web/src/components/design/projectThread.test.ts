import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  type ServerSettings,
  type ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import type { ProviderInstanceEntry } from "~/providerInstances";

import type { DesignMessage } from "./editor/backend";
import {
  NO_PROVIDER_MESSAGE,
  seedThreadComposer,
  startProjectThread,
  waitingThreadModel,
  type ProjectThreadDeps,
  type ProjectThreadInput,
  type ProjectThreadRequest,
} from "./projectThread";

const environmentId = "env-a" as EnvironmentId;
const threadId = "t-1" as ThreadId;
const projectId = "web" as ProjectId;
const ready = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as ModelSelection;
const placeholder = { instanceId: "codex", model: "gpt-6" } as ModelSelection;
const brief = "Design from code in Web app: A matchday settings page";

function request(overrides: Partial<ProjectThreadRequest> = {}): ProjectThreadRequest {
  return {
    environmentId,
    projectId,
    threadId,
    title: "A matchday settings page",
    message: { text: brief, images: [] },
    runtimeMode: "full-access",
    model: ready,
    waitingModel: null,
    ...overrides,
  };
}

/** Deps that record every call; `create` and `launch` fail with the given message. */
function recording(failures: { launch?: string; create?: string } = {}) {
  const calls = {
    launch: [] as ProjectThreadInput[],
    create: [] as ProjectThreadInput[],
    hold: [] as { thread: ScopedThreadRef; message: DesignMessage }[],
  };
  const deps: ProjectThreadDeps = {
    launch: async (input) => {
      calls.launch.push(input);
      return failures.launch ?? null;
    },
    create: async (input) => {
      calls.create.push(input);
      return failures.create ?? null;
    },
    hold: (thread, message) => calls.hold.push({ thread, message }),
  };
  return { deps, calls };
}

describe("startProjectThread", () => {
  it("launches on a ready model and never creates or holds", async () => {
    const { deps, calls } = recording();
    expect(await startProjectThread(deps, request({ waitingModel: placeholder }))).toEqual({
      ok: true,
      started: true,
    });
    expect(calls.launch).toHaveLength(1);
    expect(calls.launch[0]).toMatchObject({
      threadId,
      projectId,
      modelSelection: ready,
      message: { text: brief },
    });
    expect(calls.create).toEqual([]);
    expect(calls.hold).toEqual([]);
  });

  it("creates the thread with no turn and holds the brief when no model is ready", async () => {
    const { deps, calls } = recording();
    expect(
      await startProjectThread(deps, request({ model: null, waitingModel: placeholder })),
    ).toEqual({ ok: true, started: false });
    expect(calls.launch).toEqual([]);
    expect(calls.create).toEqual([
      {
        environmentId,
        projectId,
        threadId,
        title: "A matchday settings page",
        message: { text: brief, images: [] },
        runtimeMode: "full-access",
        modelSelection: placeholder,
      },
    ]);
    expect(calls.hold).toEqual([
      { thread: { environmentId, threadId }, message: { text: brief, images: [] } },
    ]);
  });

  it("refuses without calling anything when there is nothing to wait on", async () => {
    const { deps, calls } = recording();
    expect(await startProjectThread(deps, request({ model: null }))).toEqual({
      ok: false,
      message: NO_PROVIDER_MESSAGE,
    });
    expect(NO_PROVIDER_MESSAGE).toContain("No provider is ready");
    expect([...calls.launch, ...calls.create, ...calls.hold]).toEqual([]);
  });

  it("holds nothing when the thread was not created", async () => {
    const { deps, calls } = recording({ create: "This connection cannot change threads." });
    expect(
      await startProjectThread(deps, request({ model: null, waitingModel: placeholder })),
    ).toEqual({ ok: false, message: "This connection cannot change threads." });
    expect(calls.create).toHaveLength(1);
    expect(calls.hold).toEqual([]);
  });

  it("reports a failed launch", async () => {
    const { deps } = recording({ launch: "The provider did not respond." });
    expect(await startProjectThread(deps, request())).toEqual({
      ok: false,
      message: "The provider did not respond.",
    });
  });
});

function entry(
  instanceId: string,
  driverKind: string,
  models: { slug: string; isDefault?: boolean; isLegacy?: boolean }[],
  enabled = true,
): ProviderInstanceEntry {
  return { instanceId, driverKind, enabled, models } as unknown as ProviderInstanceEntry;
}

describe("waitingThreadModel", () => {
  const project = { id: projectId };
  const codex = entry("codex", "codex", [
    { slug: "gpt-old", isDefault: true, isLegacy: true },
    { slug: "gpt-6" },
    { slug: "gpt-6-sol", isDefault: true },
  ]);
  const claude = entry("claudeAgent", "claudeAgent", [{ slug: "claude-opus-5-5" }]);
  const claudeDefault = DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")];
  const withDefault = (selection: ModelSelection): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: selection,
  });

  it("prefers the project's default model, then this machine's", () => {
    const projectDefault = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
    expect(
      waitingThreadModel(
        withDefault(placeholder),
        { ...project, defaultModelSelection: projectDefault as ModelSelection },
        [codex, claude],
      ),
    ).toEqual(projectDefault);
    expect(waitingThreadModel(withDefault(ready), project, [codex, claude])).toEqual(ready);
  });

  it("skips a default whose provider this machine does not report", () => {
    const gone = { instanceId: "removed", model: "m-1" } as ModelSelection;
    expect(waitingThreadModel(withDefault(gone), project, [codex])).toEqual({
      instanceId: "codex",
      model: "gpt-6-sol",
    });
  });

  it("falls back to the first enabled provider's default model", () => {
    const disabled = entry("claudeAgent", "claudeAgent", [{ slug: "claude-opus-5-5" }], false);
    expect(waitingThreadModel(DEFAULT_SERVER_SETTINGS, project, [disabled, codex])).toEqual({
      instanceId: "codex",
      model: "gpt-6-sol",
    });
    // None enabled: the first provider, on its first model or its built-in default.
    expect(waitingThreadModel(DEFAULT_SERVER_SETTINGS, project, [disabled])).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    expect(
      waitingThreadModel(DEFAULT_SERVER_SETTINGS, project, [
        entry("claudeAgent", "claudeAgent", [], false),
      ]),
    ).toEqual({ instanceId: "claudeAgent", model: claudeDefault });
    expect(claudeDefault).toBeTruthy();
  });

  it("is null when this machine reports no provider, and never the no-provider placeholder", () => {
    expect(waitingThreadModel(withDefault(ready), project, [])).toBeNull();
    const unknownDriver = entry("custom", "unknown-driver", []);
    expect(waitingThreadModel(DEFAULT_SERVER_SETTINGS, project, [unknownDriver])).toBeNull();
    const placeholderDefault = withDefault({
      instanceId: "studio_no_provider",
      model: "",
    } as never);
    const picked = waitingThreadModel(placeholderDefault, project, [codex]);
    expect(picked?.instanceId).not.toBe("studio_no_provider");
    expect(picked?.model).not.toBe("");
  });
});

describe("seedThreadComposer", () => {
  function store(prompt: string | null) {
    const state = { prompt, images: [] as ComposerImageAttachment[] };
    return {
      state,
      store: {
        getComposerDraft: () => (state.prompt === null ? null : { prompt: state.prompt }),
        setPrompt: (_thread: ScopedThreadRef, next: string) => {
          state.prompt = next;
        },
        addImages: (_thread: ScopedThreadRef, images: ComposerImageAttachment[]) => {
          state.images.push(...images);
        },
      },
    };
  }
  const thread = { environmentId, threadId };

  it("puts the message in an empty composer, after anything typed there", () => {
    const empty = store(null);
    seedThreadComposer(empty.store, thread, { text: brief, images: [] });
    expect(empty.state).toEqual({ prompt: brief, images: [] });

    const typed = store("Keep the header  \n");
    seedThreadComposer(typed.store, thread, { text: brief, images: [] });
    expect(typed.state.prompt).toBe(`Keep the header\n\n${brief}`);
  });

  it("attaches the message's images as composer files", () => {
    const empty = store("");
    seedThreadComposer(
      empty.store,
      thread,
      {
        text: brief,
        images: [
          {
            name: "frame.png",
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            sizeBytes: 8,
          },
        ],
      },
      () => "img-1",
    );
    expect(empty.state.prompt).toBe(brief);
    expect(empty.state.images).toHaveLength(1);
    expect(empty.state.images[0]).toMatchObject({
      type: "image",
      id: "img-1",
      name: "frame.png",
      mimeType: "image/png",
    });
    expect(empty.state.images[0]?.file.type).toBe("image/png");
  });
});
