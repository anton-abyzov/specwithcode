import { describe, expect, it } from "@effect/vitest";
import type { SessionConfigOption } from "@specweave-studio/effect-acp/compat";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import * as Effect from "effect/Effect";
import { applyAcpModelSelection, resetAcpModelSelection } from "./AcpModelSelection.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";

const modelOption = (values: readonly string[], grouped = false): SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: values[0] ?? "auto",
  options: grouped
    ? [
        {
          groupId: "models",
          name: "Models",
          options: values.map((value) => ({ value, name: value })),
        },
      ]
    : values.map((value) => ({ value, name: value })),
});

const started = (agentName = "Copilot"): AcpSessionRuntimeStartResult => ({
  sessionId: "test-session",
  initializeResult: { protocolVersion: 1, agentInfo: { name: agentName, version: "1.0.97" } },
  sessionSetupResult: { sessionId: "test-session" },
  modelConfigId: "model",
});

const selectionRuntime = (options: readonly SessionConfigOption[]) => {
  const calls: Array<{ method: string; model: string }> = [];
  const runtime: Pick<
    AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel" | "setSessionModel"
  > = {
    getConfigOptions: Effect.succeed(options),
    setModel: (model) =>
      Effect.sync(() => {
        calls.push({ method: "config", model });
      }),
    setSessionModel: (model) =>
      Effect.sync(() => {
        calls.push({ method: "legacy", model });
        return {};
      }),
  };
  return { runtime, calls };
};

describe("ACP model selection", () => {
  for (const grouped of [false, true]) {
    it.effect(
      `forwards the exact custom model with ${grouped ? "grouped" : "flat"} duplicate auto values`,
      () =>
        Effect.gen(function* () {
          const { runtime, calls } = selectionRuntime([modelOption(["auto", "auto"], grouped)]);
          expect(yield* applyAcpModelSelection(runtime, started(), "claude-opus-5.5")).toBe(
            "claude-opus-5.5",
          );
          expect(calls).toEqual([{ method: "legacy", model: "claude-opus-5.5" }]);
        }),
    );
  }

  for (const { name, agent, values, requested } of [
    { name: "advertised auto", agent: "Copilot", values: ["auto", "auto"], requested: "auto" },
    {
      name: "advertised custom model",
      agent: "Copilot",
      values: ["auto", "claude-opus-5.5"],
      requested: "claude-opus-5.5",
    },
    {
      name: "unadvertised model in a real catalog",
      agent: "Copilot",
      values: ["auto", "other-model"],
      requested: "claude-opus-5.5",
    },
    { name: "empty config catalog", agent: "Copilot", values: [], requested: "claude-opus-5.5" },
    {
      name: "another agent's auto-only catalog",
      agent: "Other Agent",
      values: ["auto"],
      requested: "claude-opus-5.5",
    },
  ]) {
    it.effect(`preserves config selection for ${name}`, () =>
      Effect.gen(function* () {
        const { runtime, calls } = selectionRuntime([modelOption(values)]);
        yield* applyAcpModelSelection(runtime, started(agent), requested);
        expect(calls).toEqual([{ method: "config", model: requested }]);
      }),
    );
  }

  it.effect(
    "does not fall back to auto or config when session/set_model rejects the custom ID",
    () =>
      Effect.gen(function* () {
        const { runtime, calls } = selectionRuntime([modelOption(["auto"])]);
        const error = new AcpRequestError({
          method: "session/set_model",
          code: -32602,
          errorMessage: "Model unavailable",
        });
        const result = yield* applyAcpModelSelection(
          {
            ...runtime,
            setSessionModel: (model) =>
              Effect.sync(() => {
                calls.push({ method: "legacy", model });
              }).pipe(Effect.andThen(Effect.fail(error))),
          },
          started(),
          "unavailable-model",
        ).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: error });
        expect(calls).toEqual([{ method: "legacy", model: "unavailable-model" }]);
      }),
  );

  it.effect("resets an auto-only Copilot session after explicit selection of default", () =>
    Effect.gen(function* () {
      const { runtime, calls } = selectionRuntime([modelOption(["auto", "auto"], true)]);
      expect(yield* resetAcpModelSelection(runtime, started())).toBe(true);
      expect(calls).toEqual([{ method: "legacy", model: "auto" }]);
    }),
  );

  for (const { agent, values } of [
    { agent: "Copilot", values: ["auto", "claude-opus-5.5"] },
    { agent: "Copilot", values: [] },
    { agent: "Other Agent", values: ["auto"] },
  ]) {
    it.effect(
      `does not reset ${agent}'s ${JSON.stringify(values)} config through legacy selection`,
      () =>
        Effect.gen(function* () {
          const { runtime, calls } = selectionRuntime([modelOption(values)]);
          expect(yield* resetAcpModelSelection(runtime, started(agent))).toBe(false);
          expect(calls).toEqual([]);
        }),
    );
  }
});
