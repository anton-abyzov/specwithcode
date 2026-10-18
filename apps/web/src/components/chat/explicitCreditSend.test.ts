import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
const readSource = (url: URL) =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(fileURLToPath(url))).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { createRequire } from "node:module";
// The scripts workspace owns the supported legacy parser API; TypeScript 7 exports version only.
const ts = createRequire(new URL("../../../../../scripts/package.json", import.meta.url))(
  "typescript-legacy",
);
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveComposerDispatchMode } from "@specweave-studio/client-runtime/state/composer-dispatch";
import { describe, expect, it, vi } from "vite-plus/test";
import { submitComposerDraft } from "./composerSubmission";
import {
  consumeExplicitCreditSendOffer,
  deriveExplicitCreditSendOffer,
  explicitCreditSendStillMatches,
  type CreditSendContext,
} from "./explicitCreditSend";
import { settleAfter, settleCaught } from "../../lib/settle";
import { retryTransientSend } from "../../lib/transientSendRetry";
import { routesViaCoordinator } from "../../studio/projectMessageRouting";

const now = Date.parse("2026-10-09T08:00:00.000Z"),
  at = new Date(now).toISOString();
const instanceId = ProviderInstanceId.make("codex-work");
const context: CreditSendContext = {
  environmentId: "m4",
  projectId: "project-m4",
  threadId: "reserved-thread",
  draftId: "draft-1",
  runtimeMode: "approval-required",
  selection: { instanceId, model: "gpt-6.1-sol" },
  allowed: true,
};
function provider(): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.162.0",
    status: "warning",
    auth: { status: "authenticated", type: "chatgpt" },
    checkedAt: at,
    models: [{ slug: context.selection.model, name: "Sol", isCustom: false, capabilities: null }],
    skills: [],
    slashCommands: [],
    usageLimits: {
      checkedAt: at,
      windows: [],
      nativeAllowanceObservedAt: at,
      quotaPoolObservedAt: at,
      nativeRouteObservedAt: at,
      nativeRouteVerified: true,
      quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
      ordinaryUsageAllowed: false,
      spendControlReached: false,
      rateLimitReachedType: "rate_limit_reached",
      credits: { hasCredits: true, unlimited: false, balance: "0.25" },
    },
  };
}
function consume(changes: Partial<Parameters<typeof consumeExplicitCreditSendOffer>[0]> = {}) {
  const p = provider();
  return consumeExplicitCreditSendOffer({
    offer: deriveExplicitCreditSendOffer(p, context, now),
    provider: p,
    context,
    humanSubmit: true,
    dispatchMode: "auto",
    submissionIntent: "foreground",
    prompt: "Harmless current human message",
    now,
    ...changes,
  });
}

describe("explicit current credit offer", () => {
  it("binds a fresh supported native read and selected model to one wire intent", () => {
    expect(deriveExplicitCreditSendOffer(provider(), context, now)?.intent).toEqual({
      type: "human-submit-existing-credits",
      instanceId,
      model: "gpt-6.1-sol",
      expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`,
      observedAt: at,
    });
  });
  it.each([
    "checkedAt",
    "nativeAllowanceObservedAt",
    "quotaPoolObservedAt",
    "nativeRouteObservedAt",
  ] as const)("refuses stale, future, missing and malformed %s", (field) => {
    for (const value of [
      new Date(now - 60_001).toISOString(),
      new Date(now + 1).toISOString(),
      undefined,
      "invalid",
    ]) {
      const p = provider();
      Object.assign(p.usageLimits!, { [field]: value });
      expect(deriveExplicitCreditSendOffer(p, context, now)).toBeNull();
    }
  });
  it("accepts exactly 60 seconds but never fresh windows over an old allowance", () => {
    expect(deriveExplicitCreditSendOffer(provider(), context, now + 60_000)).not.toBeNull();
    expect(deriveExplicitCreditSendOffer(provider(), context, now + 60_001)).toBeNull();
  });
  it.each([
    { ordinaryUsageAllowed: true },
    { ordinaryUsageAllowed: null },
    { spendControlReached: true },
    { spendControlReached: null },
    { nativeRouteVerified: false },
    { quotaPoolId: "foreign" },
    { quotaPoolObservedAt: new Date(now - 1).toISOString() },
    { rateLimitReachedType: "workspace_member_usage_limit_reached" },
    { rateLimitReachedType: null },
    { unavailable: { reason: "probeFailed" as const } },
  ])("refuses incomplete or inadmissible native state %j", (change) => {
    const p = provider();
    Object.assign(p.usageLimits!, change);
    expect(deriveExplicitCreditSendOffer(p, context, now)).toBeNull();
  });
  it.each([null, "0", "0.000", "-1", "Infinity", "NaN", "1e10", "1.2.3", "9".repeat(25)])(
    "requires a finite positive native decimal balance: %s",
    (balance) => {
      const p = provider();
      Object.assign(p.usageLimits!.credits!, { balance });
      expect(deriveExplicitCreditSendOffer(p, context, now)).toBeNull();
    },
  );
  it.each(["nativeDenialObservedAt", "nativeCreditDenialObservedAt"])(
    "refuses equal/newer/malformed %s; older negative cannot renew proof",
    (field) => {
      for (const value of [at, new Date(now + 1).toISOString(), "invalid"]) {
        const p = provider();
        Object.assign(p.usageLimits!, { [field]: value });
        expect(deriveExplicitCreditSendOffer(p, context, now)).toBeNull();
      }
      const p = provider();
      Object.assign(p.usageLimits!, { [field]: new Date(now - 1).toISOString() });
      expect(deriveExplicitCreditSendOffer(p, context, now)).not.toBeNull();
    },
  );
  it.each([
    { driver: ProviderDriverKind.make("claudeAgent") },
    { enabled: false },
    { installed: false },
    { status: "error" as const },
    { availability: "unavailable" as const },
    { auth: { status: "authenticated" as const, type: "apiKey" } },
    { models: [] },
    { checkedAt: new Date(now - 60_001).toISOString() },
  ])("refuses a foreign, disabled, unauthenticated or stale provider: %j", (change) => {
    expect(deriveExplicitCreditSendOffer({ ...provider(), ...change }, context, now)).toBeNull();
  });
  it.each(["environmentId", "projectId", "threadId", "draftId", "runtimeMode"] as const)(
    "refuses a changed %s after preparation",
    (field) => {
      const p = provider(),
        offer = deriveExplicitCreditSendOffer(p, context, now)!;
      expect(
        explicitCreditSendStillMatches(
          offer.intent,
          context,
          { ...context, [field]: "changed" },
          p,
          now,
        ),
      ).toBe(false);
    },
  );
  it("refuses changed model, options, quota account or fresh full-read identity", () => {
    const p = provider(),
      offer = deriveExplicitCreditSendOffer(p, context, now)!;
    expect(
      explicitCreditSendStillMatches(
        offer.intent,
        context,
        {
          ...context,
          selection: { ...context.selection, options: [{ id: "reasoningEffort", value: "high" }] },
        },
        p,
        now,
      ),
    ).toBe(false);
    const changed = provider();
    Object.assign(changed.usageLimits!, { quotaPoolId: `codex:sha256:${"b".repeat(64)}` });
    expect(explicitCreditSendStillMatches(offer.intent, context, context, changed, now)).toBe(
      false,
    );
    expect(
      explicitCreditSendStillMatches({ ...offer.intent, model: "other" }, context, context, p, now),
    ).toBe(false);
    Object.assign(changed.usageLimits!, {
      quotaPoolId: p.usageLimits!.quotaPoolId,
      nativeAllowanceObservedAt: new Date(now + 1).toISOString(),
      quotaPoolObservedAt: new Date(now + 1).toISOString(),
    });
    expect(explicitCreditSendStillMatches(offer.intent, context, context, changed, now + 1)).toBe(
      false,
    );
  });
  it("consumes exactly one explicit action and cannot silently downgrade a stale credit label", () => {
    const p = provider(),
      offer = deriveExplicitCreditSendOffer(p, context, now)!;
    expect(consume({ offer, provider: p }).intent).toEqual(offer.intent);
    expect(consume({ offer, provider: p })).toEqual({ accepted: false });
    expect(consume({ now: now + 60_001 })).toEqual({ accepted: false });
    expect(consume({ context: { ...context, allowed: false } })).toEqual({ accepted: false });
    expect(consume({ prompt: " /goal do this" })).toEqual({ accepted: false });
    expect(consume({ prompt: " /compact" })).toEqual({ accepted: false });
  });
  it.each([
    { humanSubmit: false },
    { dispatchMode: "queue" },
    { dispatchMode: "steer" },
    { submissionIntent: "background" },
    { submissionIntent: "alternate" },
    { offer: null },
  ])(
    "never emits spending intent for automatic/queue/steer/background/unlabelled action %j",
    (change) => {
      expect(consume(change)).toEqual({ accepted: true });
    },
  );
});

// Execute the actual wired callbacks, extracted as TypeScript AST nodes. This catches an
// eligible helper being bypassed at the real button/keyboard or attachment-await boundary.
const composerSource = ts.createSourceFile(
  "ChatComposer.tsx",
  await readSource(new URL("./ChatComposer.tsx", import.meta.url)),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const viewSource = ts.createSourceFile(
  "ChatView.tsx",
  await readSource(new URL("../ChatView.tsx", import.meta.url)),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const runtimeSource = ts.createSourceFile(
  "runtime.ts",
  await readSource(
    new URL("../../../../../packages/client-runtime/src/state/runtime.ts", import.meta.url),
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
function nodes(source: any, predicate: (node: any) => boolean): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function actualRuntimeFunction(name: string) {
  const node = nodes(
    runtimeSource,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  )[0];
  if (!node) throw new Error(`Runtime source function missing: ${name}`);
  return new Function(
    "AsyncResult",
    "Cause",
    ts.transpile(`${node.getText(runtimeSource).replace(/^export /, "")}; return ${name};`, {
      target: ts.ScriptTarget.ES2022,
    }),
  )(AsyncResult, Cause);
}
function declaration(source: any, name: string): any {
  let found: any | undefined;
  const visit = (node: any) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`Actual declaration missing: ${name}`);
  return found;
}
function collapsedPrimaryButton(): any {
  let found: any;
  const visit = (node: any) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(composerSource) === "button" &&
      node.openingElement.attributes.properties.some(
        (attribute: any) =>
          attribute.name?.getText(composerSource) === "data-chat-composer-transition-actions",
      )
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(composerSource);
  if (!found) throw new Error("Actual collapsed primary action missing");
  return found;
}
function collapsedClick(globals: Record<string, unknown>) {
  const button = collapsedPrimaryButton();
  const attribute = button.openingElement.attributes.properties.find(
    (attribute: any) => attribute.name?.getText(composerSource) === "onClick",
  );
  return executable(composerSource, attribute.initializer.expression, globals);
}
function executable(
  source: any,
  node: any,
  globals: Record<string, unknown>,
): (...args: any[]) => any {
  const js = ts.transpile(`const callback = ${node.getText(source)};`, {
    target: ts.ScriptTarget.ES2022,
  });
  return new Function(...Object.keys(globals), `${js}; return callback;`)(
    ...Object.values(globals),
  );
}

describe("actual credit recovery callback", () => {
  it.each(["stable", "route", "model", "account", "denial", "permission", "stale"])(
    "revalidates %s after settings persistence before paid dispatch",
    async (change) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const p = provider();
        const recovery = { current: { ...context, draftId: null } };
        let selection = context.selection;
        let finish!: () => void;
        const persistence = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const start = vi.fn().mockResolvedValue({ _tag: "Success" });
        const error = vi.fn();
        const intent = deriveExplicitCreditSendOffer(p, recovery.current, now)!.intent;
        const callback = executable(viewSource, declaration(viewSource, "onResume").initializer, {
          activeThread: { id: context.threadId },
          resumableRunId: "failed-run",
          hasHeldQueuedRuns: false,
          isSendBusy: false,
          isResuming: false,
          isConnecting: false,
          isRevertingCheckpoint: false,
          threadDetailLoading: false,
          activeEnvironmentUnavailable: false,
          sendInFlightRef: { current: false },
          creditRecoveryContextRef: recovery,
          explicitCreditSendStillMatches,
          appAtomRegistry: { get: () => new Map([[context.environmentId, { providers: [p] }]]) },
          environmentServerConfigsAtom: "configs",
          environmentId: context.environmentId,
          composerRef: {
            current: { getSendContext: () => ({ selectedModelSelection: selection }) },
          },
          setResumingThreadKeys: vi.fn(),
          routeThreadKey: "original-route",
          setThreadError: error,
          projectRouting: null,
          continueWithProjectModel: async (
            _routing: unknown,
            model: unknown,
            run: (model: unknown) => unknown,
          ) => run(model),
          persistThreadSettingsForNextTurn: async () => {
            await persistence;
            return { _tag: "Success" };
          },
          localCheckoutBranchMismatch: null,
          runtimeMode: context.runtimeMode,
          interactionMode: "default",
          startThreadTurn: start,
          newMessageId: () => "new-message",
          clearUsageLimitsFor: vi.fn(),
          currentRouteThreadKeyRef: { current: "original-route" },
          scrollToEnd: vi.fn(),
          settleAfter,
          settleCaught,
        });
        const restart = {
          text: "Original unanswered prompt",
          attachments: [{ type: "file", id: "attachment" }],
        };
        const result = callback(selection, restart, intent);
        if (change === "route")
          recovery.current = { ...recovery.current, threadId: "other-thread" };
        if (change === "model") selection = { ...selection, model: "other-model" };
        if (change === "account")
          Object.assign(p.usageLimits!, { quotaPoolId: `codex:sha256:${"b".repeat(64)}` });
        if (change === "denial")
          Object.assign(p.usageLimits!, { nativeCreditDenialObservedAt: at });
        if (change === "permission") recovery.current = { ...recovery.current, allowed: false };
        if (change === "stale") vi.mocked(Date.now).mockReturnValue(now + 61_000);
        finish();
        await result;
        if (change === "stable") {
          expect(start).toHaveBeenCalledTimes(1);
          const input = start.mock.calls[0]![0].input;
          expect(input).toMatchObject({
            threadId: context.threadId,
            manualCodexCreditIntent: intent,
            dispatchMode: "start",
            message: { text: restart.text, attachments: restart.attachments },
          });
          expect(input).not.toHaveProperty("manualContinuationOfRunId");
        } else {
          expect(start).not.toHaveBeenCalled();
          expect(error).toHaveBeenLastCalledWith(
            context.threadId,
            expect.stringContaining("Credit account, model or chat changed"),
          );
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});
function actualComposer(changes: Record<string, unknown> = {}) {
  const p = provider(),
    send = vi.fn(),
    toast = vi.fn(),
    error = vi.fn();
  const initializer = declaration(composerSource, "submitComposer").initializer as any;
  const callback = executable(composerSource, initializer.arguments[0]!, {
    noProviderAvailable: false,
    isSendDisabled: false,
    readEnvironmentScope: () => true,
    environmentId: context.environmentId,
    AuthOrchestrationOperateScope: "operate",
    activeThreadId: context.threadId,
    pendingImageCompressionsRef: { current: new Map() },
    attachmentTargetKey: "draft",
    pendingDraftWork: new Set(),
    toastManager: { add: toast },
    submitComposerDraft,
    promptRef: { current: "Harmless current human message" },
    activePendingProgress: null,
    providerInputRejectedRef: { current: false },
    resolveComposerDispatchMode,
    phase: "ready",
    settings: { followUpBehavior: "steer" },
    consumeExplicitCreditSendOffer,
    explicitCreditOffer: deriveExplicitCreditSendOffer(p, context, now),
    selectedProviderStatus: p,
    creditSendContext: context,
    onSend: send,
    setComposerSubmissionError: error,
    shouldBlurMobileComposerOnSubmit: () => false,
    blurMobileComposerAfterSend: vi.fn(),
    ...changes,
  });
  return { callback, send, toast };
}
describe("actual callback integration", () => {
  it("refuses an already-captured credit intent before coordinator routing and preserves the draft", async () => {
    const reject = vi.fn(),
      route = vi.fn(),
      prompt = { current: "Keep this project draft" };
    const callback = executable(viewSource, declaration(viewSource, "onSend").initializer, {
      projectDraftSendGuard: { preventSend: () => false },
      usageLimitsOffered: false,
      appCommandsOffered: false,
      projectRouting: { send: vi.fn(), coordinatorThreadId: "coordinator" },
      activePendingProgress: null,
      currentCreditRouteRef: { current: { allowed: true } },
      composerRef: { current: { rejectCreditSubmission: reject } },
      routeProjectComposerSend: route,
      routesViaCoordinator,
      promptRef: prompt,
    });
    await callback(
      undefined,
      "auto",
      "foreground",
      undefined,
      deriveExplicitCreditSendOffer(provider(), context, now)!.intent,
    );
    expect(reject).toHaveBeenCalledOnce();
    expect(route).not.toHaveBeenCalled();
    expect(prompt.current).toBe("Keep this project draft");
  });

  it.each([false, true])(
    "actual outer-await continuation checks current context synchronously (changed=%s)",
    async (invalidate) => {
      const settings = nodes(
        viewSource,
        (node) =>
          ts.isIfStatement(node) &&
          node.expression.getText(viewSource) ===
            "failure === null && isServerThread && creditIntentStillCurrent()",
      )[0];
      const attachmentFailure = nodes(
        viewSource,
        (node) =>
          ts.isIfStatement(node) &&
          node.expression.getText(viewSource) ===
            'failure === null && turnAttachmentsResult._tag === "Failure"',
      )[0];
      const restore = nodes(
        viewSource,
        (node) =>
          ts.isIfStatement(node) &&
          node.expression.getText(viewSource) === "failure !== null" &&
          node.getText(viewSource).includes("promptRef.current = messageTextForSend"),
      )[0];
      if (!settings || !attachmentFailure || !restore)
        throw new Error("Actual send failure pipeline missing");
      let current = true,
        checks = 0,
        optimistic = [{ id: "message" }];
      const send = vi.fn(
          async (_request: { input: { manualCodexCreditIntent: { type: string } } }) =>
            AsyncResult.success(undefined),
        ),
        prompt = { current: "" },
        error = vi.fn();
      const globals = {
        isServerThread: true,
        threadIdForSend: context.threadId,
        messageCreatedAt: at,
        localCheckoutBranchMismatch: null,
        runtimeMode: context.runtimeMode,
        sendInteractionMode: "default",
        settlePromise: actualRuntimeFunction("settlePromise"),
        retryTransientSend,
        whenHostReady: async () => true,
        commandIdForSend: "command",
        turnAttachmentsPromise: Promise.resolve([]),
        creditIntentStillCurrent: () => {
          checks++;
          if (checks === 2 && invalidate)
            queueMicrotask(() => {
              current = false;
            });
          return current;
        },
        persistThreadSettingsForNextTurn: async () => AsyncResult.success(undefined),
        readLiveAttachmentCapabilities: () => ({ fileBlockReason: null }),
        environmentId: context.environmentId,
        messageIdForSend: "message",
        outgoingMessageText: "Human input",
        buildOutgoingMessageContext: () => undefined,
        ctxSelectedModelSelection: context.selection,
        title: "Human input",
        dispatchMode: "auto",
        bootstrap: undefined,
        manualCodexCreditIntent: deriveExplicitCreditSendOffer(provider(), context, now)!.intent,
        startThreadTurn: send,
        submissionIntent: "foreground",
        backgroundDraftOpened: false,
        promptRef: prompt,
        composerImagesRef: { current: [] },
        composerFilesRef: { current: [] },
        composerTerminalContextsRef: { current: [] },
        composerDraftTarget: "draft",
        messageTextForSend: "Human input",
        useComposerDraftStore: {
          getState: () => ({
            getComposerDraft: () => ({
              previewAnnotations: [],
              reviewComments: [],
              threadContexts: [],
            }),
          }),
        },
        setOptimisticUserMessages: (update: any) => {
          optimistic = update(optimistic);
        },
        revokeUserMessagePreviewUrls: vi.fn(),
        composerImagesSnapshot: [],
        composerFilesSnapshot: [],
        composerTerminalContextsSnapshot: [],
        composerPreviewAnnotationsSnapshot: [],
        composerReviewCommentsSnapshot: [],
        composerThreadContextsSnapshot: [],
        cloneComposerImageForRetry: vi.fn(),
        setComposerDraftPrompt: vi.fn(),
        addComposerDraftImages: vi.fn(),
        addComposerDraftFiles: vi.fn(),
        setComposerDraftTerminalContexts: vi.fn(),
        setComposerDraftPreviewAnnotations: vi.fn(),
        setComposerDraftReviewComments: vi.fn(),
        setComposerDraftThreadContexts: vi.fn(),
        composerRef: { current: { resetCursorState: vi.fn() } },
        collapseExpandedComposerCursor: (_text: string, cursor: number) => cursor,
        isAtomCommandInterrupted: actualRuntimeFunction("isAtomCommandInterrupted"),
        squashAtomCommandFailure: actualRuntimeFunction("squashAtomCommandFailure"),
        setThreadError: error,
      };
      const body = `async function callback() { let failure = null;
      ${settings.getText(viewSource)}
      const ${declaration(viewSource, "turnAttachmentsResult").getText(viewSource)};
      ${attachmentFailure.getText(viewSource)}
      if (failure === null && turnAttachmentsResult._tag === "Success") {
        const ${declaration(viewSource, "startPromise").getText(viewSource)};
        const startResult = await startPromise; if (startResult._tag === "Failure") failure = startResult;
      }
      ${restore.getText(viewSource)}
      return failure;
    }; return callback;`;
      const callback = new Function(
        ...Object.keys(globals),
        ts.transpile(body, { target: ts.ScriptTarget.ES2022 }),
      )(...Object.values(globals));
      const result = await callback();
      expect(checks).toBe(3);
      if (invalidate) {
        expect(result._tag).toBe("Failure");
        expect(send).not.toHaveBeenCalled();
        expect(prompt.current).toBe("Human input");
        expect(optimistic).toEqual([]);
        expect(globals.setComposerDraftPrompt).toHaveBeenCalledWith("draft", "Human input");
        expect(error.mock.calls[0]?.[1]).toContain(
          "Credit availability or the selected draft changed",
        );
      } else {
        expect(result).toBeNull();
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0]?.[0]?.input.manualCodexCreditIntent.type).toBe(
          "human-submit-existing-credits",
        );
        expect(globals.setComposerDraftPrompt).not.toHaveBeenCalled();
      }
    },
  );
  it("actual collapsed mobile human control carries exactly one credit intent", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const actual = actualComposer();
      const resume = vi.fn();
      const click = collapsedClick({
        showResumeAction: false,
        onResume: resume,
        submitComposer: actual.callback,
      });
      const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
      click(event);
      click(event);
      expect(actual.send).toHaveBeenCalledOnce();
      expect(actual.send.mock.calls[0]?.[3]?.type).toBe("human-submit-existing-credits");
      expect(resume).not.toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("actual collapsed mobile control refuses stale credit proof and leaves Resume ordinary", () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    try {
      const actual = actualComposer(),
        resume = vi.fn();
      const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
      collapsedClick({
        showResumeAction: false,
        onResume: resume,
        submitComposer: actual.callback,
      })(event);
      expect(actual.send).not.toHaveBeenCalled();
      expect(actual.toast).toHaveBeenCalledOnce();
      collapsedClick({ showResumeAction: true, onResume: resume, submitComposer: actual.callback })(
        event,
      );
      expect(resume).toHaveBeenCalledOnce();
      expect(actual.send).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("the actual collapsed label and visible content identify the eligible credit action", () => {
    const label = declaration(
      composerSource,
      "collapsedComposerPrimaryActionLabel",
    ).initializer.getText(composerSource);
    const evaluate = (showResumeAction: boolean, explicitCreditOffer: unknown) =>
      new Function("showResumeAction", "explicitCreditOffer", `return ${label}`)(
        showResumeAction,
        explicitCreditOffer,
      );
    expect(evaluate(false, {})).toBe("Send with credits");
    expect(evaluate(false, null)).toBe("Send message");
    expect(evaluate(true, null)).toBe("Resume thread");
    expect(collapsedPrimaryButton().getText(composerSource)).toContain(
      "<span>Send with credits</span>",
    );
  });
  it.each([
    { props: { allowManualCodexCredits: false } },
    { multipleModelSelections: [] },
    { canInterrupt: true },
    { canResume: true },
    { phase: "running" },
    { phase: "connecting" },
    { isSendBusy: true },
    { isConnecting: true },
    { isRevertingCheckpoint: true },
    { isPreparingWorktree: true },
    { environmentUnavailable: "offline" },
    { projectSelectionRequired: true },
    { isEditingQueuedMessage: true },
    { activePendingApproval: {} },
    { pendingUserInputs: [{}] },
    { showPlanFollowUpPrompt: true },
    { props: { activeThreadShell: { goal: {} } } },
    { prompt: "/goal continue" },
    { prompt: "/compact" },
  ])("actual rendered offer excludes the non-human-start context %j", (change) => {
    const initializer = declaration(composerSource, "creditSendContext").initializer as any;
    const actualContext = executable(composerSource, initializer.arguments[0], {
      environmentId: context.environmentId,
      activeThread: { projectId: context.projectId },
      props: {},
      activeThreadId: context.threadId,
      draftId: context.draftId,
      runtimeMode: context.runtimeMode,
      selectedModelSelection: context.selection,
      canOperateThread: true,
      multipleModelSelections: null,
      canInterrupt: false,
      canResume: false,
      phase: "ready",
      isSendBusy: false,
      isConnecting: false,
      isRevertingCheckpoint: false,
      isPreparingWorktree: false,
      environmentUnavailable: null,
      projectSelectionRequired: false,
      isEditingQueuedMessage: false,
      activePendingApproval: null,
      pendingUserInputs: [],
      showPlanFollowUpPrompt: false,
      prompt: "Hello",
      ...change,
    });
    expect(actualContext().allowed).toBe(false);
    expect(deriveExplicitCreditSendOffer(provider(), actualContext(), now)).toBeNull();
  });

  it("actual composer emits the fourth intent only for explicit button/keyboard submit", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const human = actualComposer();
      human.callback(undefined, "auto", "foreground", true);
      expect(human.send.mock.calls[0]?.[3]?.type).toBe("human-submit-existing-credits");
      const automatic = actualComposer();
      automatic.callback();
      expect(automatic.send.mock.calls[0]?.[3]).toBeUndefined();
      const background = actualComposer();
      background.callback(undefined, "auto", "background", true);
      expect(background.send.mock.calls[0]?.[3]).toBeUndefined();
      const annotation = actualComposer();
      annotation.callback(undefined, "auto");
      expect(annotation.send.mock.calls[0]?.[3]).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("actual composer refuses an expired rendered label before onSend", () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    try {
      const actual = actualComposer();
      actual.callback(undefined, "auto", "foreground", true);
      expect(actual.send).not.toHaveBeenCalled();
      expect(actual.toast).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("actual source human paths explicitly mark submit; citation and automatic entry remain ordinary", () => {
    const handle = declaration(composerSource, "handleSubmitMessage").getText(composerSource);
    expect(handle).toMatch(/undefined,\s*true,/);
    expect(
      declaration(composerSource, "submitCitationAndSend").getText(composerSource),
    ).not.toMatch(/true,/);
    expect(composerSource.text).toContain(
      "onSubmit={(event) => submitComposer(event, undefined, undefined, true)}",
    );
    expect(composerSource.text).toMatch(/submissionIntent,\s*true,\s*\);\s*return true/);
    expect(
      /onSend=\{\(event, mode, intent, credit\) =>\s*onSend\(event, mode, intent, undefined, credit\)\s*\}/.test(
        viewSource.text,
      ),
    ).toBe(true);
    expect(
      viewSource.text.match(
        /\.\.\.\(manualCodexCreditIntent \? \{ manualCodexCreditIntent \} : \{\}\)/g,
      ),
    ).toHaveLength(1);
  });
  it.each(["stable", "route", "draft", "model", "account", "denial", "runtime", "goal"])(
    "real attachment-await callback rechecks %s before main native dispatch",
    async (change) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const p = provider(),
          offer = deriveExplicitCreditSendOffer(p, context, now)!;
        const current = { ...context },
          route = { current: "route" };
        const draft = { ...context, promotedTo: null };
        let selection = context.selection;
        const check = executable(
          viewSource,
          declaration(viewSource, "creditIntentStillCurrent").initializer!,
          {
            manualCodexCreditIntent: offer.intent,
            composerRef: {
              current: { getSendContext: () => ({ selectedModelSelection: selection }) },
            },
            currentRouteThreadKeyRef: route,
            routeThreadKey: "route",
            environmentChangeRef: { current: null },
            draftMachinePendingRef: { current: false },
            readEnvironmentScope: () => true,
            environmentId: context.environmentId,
            AuthOrchestrationOperateScope: "operate",
            draftId: context.draftId,
            useComposerDraftStore: { getState: () => ({ getDraftSession: () => draft }) },
            capturedCreditContext: context,
            currentCreditRouteRef: { current },
            explicitCreditSendStillMatches,
            environmentServerConfigsAtom: "configs",
            appAtomRegistry: { get: () => new Map([[context.environmentId, { providers: [p] }]]) },
          },
        );
        expect(check()).toBe(true);
        let finish!: () => void;
        const attachments = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const initializer = declaration(viewSource, "turnAttachmentsResult").initializer as any;
        const call = initializer.expression as any;
        const actualAwait = executable(viewSource, call.arguments[0]!, {
          turnAttachmentsPromise: attachments,
          creditIntentStillCurrent: check,
          readLiveAttachmentCapabilities: () => ({ fileBlockReason: null }),
        });
        const result = actualAwait();
        if (change === "route") route.current = "other";
        if (change === "draft") draft.projectId = "other";
        if (change === "model") selection = { ...selection, model: "other" };
        if (change === "account")
          Object.assign(p.usageLimits!, { quotaPoolId: `codex:sha256:${"b".repeat(64)}` });
        if (change === "denial")
          Object.assign(p.usageLimits!, { nativeCreditDenialObservedAt: at });
        if (change === "runtime") current.runtimeMode = "full-access";
        if (change === "goal") current.allowed = false;
        finish();
        if (change === "stable") await expect(result).resolves.toBeUndefined();
        else
          await expect(result).rejects.toThrow("Credit availability or the selected draft changed");
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});
