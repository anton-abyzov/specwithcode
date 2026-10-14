import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "@specweave-studio/effect-acp/compat";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import { synchronizeAcpPermissions } from "./AcpPermissions.ts";
import { configureAcpOptions } from "./AcpConfigureOptions.ts";
import { acpProviderOptionDescriptors } from "./AcpSessionConfig.ts";

function fixture(initial: Schema.SessionConfigOption[], behavior = "accept") {
  let options = initial;
  const calls: Array<[string, string | boolean]> = [];
  const runtime = {
    getConfigOptions: Effect.sync(() => options),
    getModeState: Effect.succeed(undefined),
    setMode: () => Effect.succeed({}),
    setConfigOption: (id: string, value: string | boolean) =>
      Effect.gen(function* () {
        calls.push([id, value]);
        if (behavior === "reject")
          return yield* new AcpRequestError({
            method: "session/set_config_option",
            code: -32602,
            errorMessage: "Rejected",
          });
        if (behavior === "accept")
          options = options.map((option) =>
            option.id === id
              ? ({ ...option, currentValue: value } as Schema.SessionConfigOption)
              : option,
          );
        return { configOptions: options };
      }),
  };
  return {
    runtime,
    calls,
    reset: (next: Schema.SessionConfigOption[]) => {
      options = next;
    },
  };
}
const toggle = (value: boolean, id = "allowAll"): Schema.SessionConfigOption => ({
  id,
  name: "Allow All",
  type: "boolean",
  currentValue: value,
});
const select = (value: string): Schema.SessionConfigOption => ({
  id: "allow_all",
  name: "Allow All",
  type: "select",
  currentValue: value,
  options: [
    { value: "on", name: "On" },
    { value: "off", name: "Off" },
  ],
});

describe("Studio-owned ACP permissions", () => {
  for (const mode of ["full-access", "approval-required", "auto-accept-edits", "auto"] as const) {
    for (const format of ["boolean", "select"]) {
      it.effect(`${mode} controls ${format} Allow All`, () =>
        Effect.gen(function* () {
          const enabled = mode === "full-access";
          const f = fixture([
            format === "boolean" ? toggle(!enabled) : select(enabled ? "off" : "on"),
          ]);
          yield* synchronizeAcpPermissions(f.runtime, mode);
          expect(f.calls).toEqual([
            [
              format === "boolean" ? "allowAll" : "allow_all",
              format === "boolean" ? enabled : enabled ? "on" : "off",
            ],
          ]);
          yield* synchronizeAcpPermissions(f.runtime, mode);
          expect(f.calls).toHaveLength(1);
        }),
      );
    }
  }
  it.effect("reconciles transitions and restored/provider-updated configuration", () =>
    Effect.gen(function* () {
      const f = fixture([toggle(false, "allow-all")]);
      for (const mode of [
        "full-access",
        "approval-required",
        "full-access",
        "auto",
      ] as RuntimeMode[])
        yield* synchronizeAcpPermissions(f.runtime, mode);
      f.reset([toggle(true, "allow-all")]);
      yield* synchronizeAcpPermissions(f.runtime, "auto");
      expect(f.calls.map((c) => c[1])).toEqual([true, false, true, false, false]);
    }),
  );
  it.effect("ignores saved permission overrides while applying reasoning options", () =>
    Effect.gen(function* () {
      const f = fixture([
        toggle(true),
        {
          id: "effort",
          name: "Reasoning",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ]);
      yield* configureAcpOptions(
        f.runtime,
        {
          instanceId: ProviderInstanceId.make("test"),
          model: "default",
          options: [
            { id: "allowAll", value: true },
            { id: "effort", value: "high" },
          ],
        },
        { runtimeMode: "approval-required", interactionMode: "default", cwd: null },
        ProviderDriverKind.make("acp"),
        "session",
        new Map(),
      );
      expect(f.calls).toEqual([
        ["effort", "high"],
        ["allowAll", false],
      ]);
    }),
  );
  for (const behavior of ["reject", "ignore"])
    it.effect(`blocks when provider ${behavior}s synchronization`, () =>
      Effect.gen(function* () {
        const f = fixture([toggle(true)], behavior);
        const result = yield* synchronizeAcpPermissions(f.runtime, "approval-required").pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.message).toContain("Cannot synchronize provider Allow All");
      }),
    );
  it.effect("fails closed on unknown choice values", () =>
    Effect.gen(function* () {
      const f = fixture([
        {
          ...select("custom"),
          options: [{ value: "custom", name: "Custom" }],
        } as Schema.SessionConfigOption,
      ]);
      expect(
        (yield* synchronizeAcpPermissions(f.runtime, "full-access").pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.calls).toEqual([]);
    }),
  );
  it.effect("leaves unrelated options and providers without Allow All alone", () =>
    Effect.gen(function* () {
      const f = fixture([toggle(false, "allowAllEdits")]);
      yield* synchronizeAcpPermissions(f.runtime, "full-access");
      expect(f.calls).toEqual([]);
    }),
  );
  it("omits blanket approval descriptors but preserves reasoning and agent controls", () => {
    expect(
      acpProviderOptionDescriptors({
        configOptions: [toggle(false), select("off"), toggle(false, "thinking")],
        modeState: undefined,
      }).map((o) => o.id),
    ).toEqual(["thinking"]);
  });
});
