import { describe, expect, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@specweave-studio/contracts";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  acknowledgeCopilotStartupModel,
  confirmCopilotStartupModel,
  isCopilotStartupModelCandidate,
  resetCopilotStartupModel,
  supportsCopilotStartupModel,
} from "./CopilotStartupModel.ts";
import type { ResolvedAcpRegistryAgent } from "./AcpRegistrySupport.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";

const selected = "claude-opus-5.5";
const settings = Schema.decodeSync(AcpRegistrySettings)({ agentId: "github-copilot-cli" });
const resolved: ResolvedAcpRegistryAgent = {
  agent: {
    id: "github-copilot-cli",
    name: "GitHub Copilot",
    version: "1.0.97",
    description: "Fixture",
    distribution: { npx: { package: "@github/copilot@1.0.97", args: ["--acp", "--stdio"] } },
  },
  distribution: "npx",
  spawn: { command: "/fixture/copilot", args: ["--acp", "--stdio"] },
};
const started = (current: string | undefined = selected): AcpSessionRuntimeStartResult => ({
  sessionId: "native-session",
  modelConfigId: undefined,
  initializeResult: { protocolVersion: 1, agentInfo: { name: "Copilot", version: "1.0.97" } },
  sessionSetupResult: {
    sessionId: "native-session",
    ...(current === undefined
      ? {}
      : {
          models: { currentModelId: current, availableModels: [{ modelId: "auto", name: "Auto" }] },
        }),
  },
});

function nativeRuntime(initial = started()) {
  const calls: string[] = [];
  const change = (kind: string, model: string) =>
    Effect.gen(function* () {
      calls.push(`${kind}:${model}`);
      if (model === "denied")
        return yield* new AcpRequestError({ code: -32602, errorMessage: "Native denied model" });
      return {};
    });
  const runtime = {
    start: () => Effect.succeed(initial),
    getConfigOptions: Effect.succeed([]),
    setModel: (model: string) => change("config", model).pipe(Effect.asVoid),
    setSessionModel: (model: string) => change("legacy", model),
    setConfigOption: (id: string, value: string) => change(id, value).pipe(Effect.asVoid),
    loadSession: () =>
      Effect.sync(() => {
        calls.push("load");
        return initial;
      }),
    resumeSession: () =>
      Effect.sync(() => {
        calls.push("resume");
        return initial;
      }),
    forkSession: () =>
      Effect.sync(() => {
        calls.push("fork");
        return initial;
      }),
  } as unknown as AcpSessionRuntime["Service"];
  return { runtime, calls };
}

describe("Copilot startup model", () => {
  it("requires the official registry identity and an explicit model", () => {
    expect(isCopilotStartupModelCandidate(settings, resolved, selected)).toBe(true);
    for (const model of [undefined, "", "default", "auto"])
      expect(isCopilotStartupModelCandidate(settings, resolved, model)).toBe(false);
    expect(
      isCopilotStartupModelCandidate({ ...settings, source: "local" }, resolved, selected),
    ).toBe(false);
    expect(
      isCopilotStartupModelCandidate(
        { ...settings, commandPath: "/custom/copilot" },
        resolved,
        selected,
      ),
    ).toBe(false);
    expect(
      isCopilotStartupModelCandidate({ ...settings, agentId: "lookalike" }, resolved, selected),
    ).toBe(false);
    expect(
      isCopilotStartupModelCandidate(
        settings,
        { distribution: resolved.distribution, spawn: resolved.spawn },
        selected,
      ),
    ).toBe(false);
    expect(
      isCopilotStartupModelCandidate(settings, { ...resolved, distribution: "local" }, selected),
    ).toBe(false);
    expect(
      isCopilotStartupModelCandidate(
        settings,
        {
          ...resolved,
          agent: { ...resolved.agent!, distribution: { npx: { package: "other-copilot@1.0.97" } } },
        },
        selected,
      ),
    ).toBe(false);
  });

  it("accepts only actual audited version and exact help flag", () => {
    expect(
      supportsCopilotStartupModel(
        "GitHub Copilot CLI 1.0.97.\nCommit: fixture",
        "  --model <model> Select model",
      ),
    ).toBe(true);
    expect(supportsCopilotStartupModel("1.0.97", "--model=MODEL")).toBe(true);
    for (const version of ["1.0.95", "1.0.98", "2.0.0", "1.0.970", "1.0.97-beta", "unknown"]) {
      expect(supportsCopilotStartupModel(version, "--model <model>")).toBe(false);
    }
    expect(supportsCopilotStartupModel("1.0.97", "--model-list")).toBe(false);
  });

  for (const current of ["auto", "other-model", ""]) {
    it.effect(`rejects native current model ${JSON.stringify(current)}`, () =>
      Effect.gen(function* () {
        const result = yield* confirmCopilotStartupModel(started(current), selected).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  }

  it.effect("does not invent confirmation when native model metadata is absent", () =>
    Effect.gen(function* () {
      const initial = { ...started(), sessionSetupResult: { sessionId: "native-session" } };
      expect(yield* confirmCopilotStartupModel(initial, selected)).toBe(false);
      const { runtime, calls } = nativeRuntime(initial);
      const wrapped = acknowledgeCopilotStartupModel(runtime, selected);
      yield* wrapped.start();
      yield* wrapped.setSessionModel(selected);
      expect(calls).toEqual([`legacy:${selected}`]);
    }),
  );

  it.effect("rejects a conflicting model config even when legacy metadata matches", () =>
    Effect.gen(function* () {
      const base = started();
      const initial: AcpSessionRuntimeStartResult = {
        ...base,
        sessionSetupResult: {
          ...base.sessionSetupResult,
          configOptions: [
            {
              id: "model",
              category: "model",
              name: "Model",
              type: "select",
              currentValue: "auto",
              options: [{ value: "auto", name: "Auto" }],
            },
          ],
        },
      };
      expect((yield* confirmCopilotStartupModel(initial, selected).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }),
  );

  it.effect("consumes confirmation once and preserves A to B to A and default reset", () =>
    Effect.gen(function* () {
      const { runtime, calls } = nativeRuntime();
      const wrapped = acknowledgeCopilotStartupModel(runtime, selected);
      const initial = yield* wrapped.start();
      yield* wrapped.setSessionModel(selected);
      expect(calls).toEqual([]);
      yield* wrapped.setSessionModel("other-model");
      yield* wrapped.start();
      yield* wrapped.setSessionModel(selected);
      expect(yield* resetCopilotStartupModel(wrapped)).toBe(true);
      expect(calls).toEqual(["legacy:other-model", `legacy:${selected}`, "legacy:auto"]);
      expect(initial.sessionSetupResult.models?.availableModels).toEqual([
        { modelId: "auto", name: "Auto" },
      ]);
      expect(yield* resetCopilotStartupModel(runtime)).toBe(false);
    }),
  );

  for (const activation of ["loadSession", "resumeSession", "forkSession"] as const) {
    it.effect(`invalidates startup acknowledgement after ${activation}`, () =>
      Effect.gen(function* () {
        const { runtime, calls } = nativeRuntime();
        const wrapped = acknowledgeCopilotStartupModel(runtime, selected);
        yield* wrapped.start();
        yield* wrapped[activation]("another-session");
        yield* wrapped.setSessionModel(selected);
        expect(calls.at(-1)).toBe(`legacy:${selected}`);
      }),
    );
  }

  it.effect("keeps native setter rejection and never retries auto", () =>
    Effect.gen(function* () {
      const { runtime, calls } = nativeRuntime();
      const wrapped = acknowledgeCopilotStartupModel(runtime, selected);
      yield* wrapped.start();
      yield* wrapped.setModel(selected);
      const result = yield* wrapped.setSessionModel("denied").pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { errorMessage: "Native denied model" },
      });
      expect(calls).toEqual(["legacy:denied"]);
    }),
  );
});
