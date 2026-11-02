import {
  type ModelSelection,
  OrchestrationV2DispatchCommandError,
  CommandId,
  type TeamRulesSummary,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  limitRuntimeModeChoices,
  RUNTIME_MODE_CHOICES,
} from "../features/threads/thread-settings-options";
import {
  chromeOffNote,
  queuedTurnTeamRulesRefusal,
  routineFailureText,
  routineRuntimeModeLock,
  sharedRuntimeModeLock,
  teamRulesRows,
  teamRulesStateOf,
  threadCarriedCeiling,
  threadRuntimeModeLock,
} from "./teamRules";
import {
  isTeamRulesRefusal,
  resolveThreadOutboxFailureAction,
  shouldRetryThreadOutboxDelivery,
} from "./thread-outbox-model";

const active = (rules: Partial<TeamRulesSummary> = {}): TeamRulesSummary => ({
  status: "active",
  owner: "Acme IT",
  fingerprint: "abc",
  ...rules,
});
const carriedThread = {
  origin: {
    carried: { ceiling: "auto-accept-edits", owner: "Globex", from: "env-a" },
  },
};
const selection = { instanceId: "codex", model: "gpt-5.4" } as unknown as ModelSelection;
const configWith = (teamRules?: TeamRulesSummary) =>
  ({
    providers: [{ instanceId: "codex", driver: "codex" }],
    ...(teamRules === undefined ? {} : { teamRules }),
  }) as unknown as Parameters<typeof queuedTurnTeamRulesRefusal>[0];

// The server's error, under the tag it fails with, over the same schema the RPC uses.
class OrchestratorTeamRulesRefusedError extends Schema.TaggedError<OrchestratorTeamRulesRefusedError>()(
  "OrchestratorTeamRulesRefusedError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
const encodeDispatchError = Schema.encodeUnknownSync(OrchestrationV2DispatchCommandError);
const decodeDispatchError = Schema.decodeUnknownSync(OrchestrationV2DispatchCommandError);
const overTheWire = (cause: unknown, message = "Acme IT's rules allow up to Auto.") => {
  const encoded = encodeDispatchError(
    new OrchestrationV2DispatchCommandError({
      commandId: CommandId.make("command"),
      commandType: "thread.runtime-mode.set",
      message,
      detail: message,
      cause,
    }),
  );
  return decodeDispatchError(JSON.parse(JSON.stringify(encoded)));
};

describe("a machine without rules", () => {
  it("reads a missing field as no rules", () => {
    expect(teamRulesStateOf({}).status).toBe("none");
    expect(teamRulesStateOf(null).status).toBe("none");
  });

  it("leaves every picker and message alone", () => {
    expect(threadRuntimeModeLock({}, {})).toBeUndefined();
    expect(routineRuntimeModeLock({})).toBeUndefined();
    expect(sharedRuntimeModeLock([{}, null])).toBeUndefined();
    expect(limitRuntimeModeChoices(RUNTIME_MODE_CHOICES, undefined)).toBe(RUNTIME_MODE_CHOICES);
    expect(chromeOffNote([{}])).toBeNull();
    expect(
      queuedTurnTeamRulesRefusal(
        configWith(),
        {},
        {
          runtimeMode: "full-access",
          modelSelection: selection,
        },
      ),
    ).toBeNull();
  });

  it("keeps a routine failure's existing text", () => {
    const failure = new Error("nope");
    expect(routineFailureText({}, failure)).toBe(String(failure));
  });
});

describe("permission pickers", () => {
  it("locks modes above the ceiling and names who set it", () => {
    const choices = limitRuntimeModeChoices(
      RUNTIME_MODE_CHOICES,
      threadRuntimeModeLock({ teamRules: active({ ceiling: "auto" }) }, {}),
    );
    expect(choices.map((choice) => choice.lockedBy)).toEqual([
      undefined,
      undefined,
      undefined,
      "Set by Acme IT",
    ]);
    expect(choices[3]?.description).toBe("Set by Acme IT. Above your team's limit.");
    expect(choices[0]?.description).toBe(RUNTIME_MODE_CHOICES[0]?.description);
  });

  it("respects a carried ceiling on a machine with no rules", () => {
    expect(threadCarriedCeiling(carriedThread)?.owner).toBe("Globex");
    const lock = threadRuntimeModeLock({}, carriedThread);
    expect(lock?.("auto-accept-edits")).toBeNull();
    expect(lock?.("auto")).toBe("Set by Globex");
  });

  it("uses the stricter of the machine's ceiling and the carried one", () => {
    const lock = threadRuntimeModeLock(
      { teamRules: active({ ceiling: "approval-required" }) },
      carriedThread,
    );
    expect(lock?.("auto-accept-edits")).toBe("Set by Acme IT");
  });

  it("limits routines by the routine ceiling", () => {
    const lock = routineRuntimeModeLock({
      teamRules: active({ ceiling: "full-access", routinesCeiling: "auto" }),
    });
    expect(lock?.("auto")).toBeNull();
    expect(lock?.("full-access")).toBe("Set by Acme IT");
  });

  it("locks a shared default when any selected machine limits it", () => {
    const lock = sharedRuntimeModeLock([{}, { teamRules: active({ ceiling: "auto" }) }]);
    expect(lock?.("auto")).toBeNull();
    expect(lock?.("full-access")).toBe("Set by Acme IT");
  });

  it("does not lock modes during a hold, where the section explains the pause", () => {
    expect(threadRuntimeModeLock({ teamRules: { status: "hold" } }, {})).toBeUndefined();
  });
});

describe("Team rules section", () => {
  it("shows only what the rules set", () => {
    expect(teamRulesRows(active())).toEqual([]);
  });

  it("lists reach and tools", () => {
    const rows = teamRulesRows(
      active({
        ceiling: "auto",
        reach: { phones: false, machines: "same-rules", webhooks: false },
        tools: { chrome: false, telegram: false },
      }),
    );
    expect(rows.map((row) => row.title)).toEqual([
      "Broadest permission",
      "Routines",
      "Phones",
      "Other machines",
      "Webhooks",
      "Agent use of Chrome",
      "Telegram",
    ]);
    expect(rows[3]?.value).toBe("Only machines with the same rules");
  });

  it("notes Chrome without locking preview", () => {
    expect(chromeOffNote([{ teamRules: active({ tools: { chrome: false } }) }])).toBe(
      "Agent use of Chrome is off. Set by Acme IT.",
    );
  });
});

describe("refusals", () => {
  it("answers before sending with the server's wording", () => {
    expect(
      queuedTurnTeamRulesRefusal(
        configWith(active({ ceiling: "auto" })),
        {},
        {
          runtimeMode: "full-access",
          modelSelection: selection,
        },
      ),
    ).toBe("Acme IT's rules allow up to Auto, so Full access is not available.");
  });

  it("refuses a model off the list and any turn during a hold", () => {
    expect(
      queuedTurnTeamRulesRefusal(configWith(active({ models: ["claude-*"] })), null, {
        runtimeMode: "auto",
        modelSelection: selection,
      }),
    ).toBe("Acme IT's rules do not approve the model gpt-5.4.");
    expect(
      queuedTurnTeamRulesRefusal(configWith({ status: "hold" }), null, {
        runtimeMode: "auto",
        modelSelection: selection,
      }),
    ).toContain("Agents are paused");
  });

  it("refuses above a carried ceiling", () => {
    expect(
      queuedTurnTeamRulesRefusal(configWith(), carriedThread, {
        runtimeMode: "full-access",
        modelSelection: selection,
      }),
    ).toContain("This work came from a machine where Globex's rules");
  });

  it("recognizes a refusal after it crosses the wire", () => {
    const error = overTheWire(new OrchestratorTeamRulesRefusedError({ detail: "Refused." }));
    expect(isTeamRulesRefusal(error)).toBe(true);
    expect(error.message).toBe("Acme IT's rules allow up to Auto.");
    expect(isTeamRulesRefusal(overTheWire(new Error("Thread is gone")))).toBe(false);
    expect(isTeamRulesRefusal(new Error("Acme IT's rules"))).toBe(false);
  });

  it("restores instead of retrying forever, at every stage", () => {
    const error = overTheWire(new OrchestratorTeamRulesRefusedError({ detail: "Refused." }));
    expect(shouldRetryThreadOutboxDelivery(error)).toBe(false);
    for (const stage of ["settings-sync", "start-turn"] as const) {
      expect(resolveThreadOutboxFailureAction({ stage, error, interrupted: false })).toBe(
        "restore",
      );
      expect(resolveThreadOutboxFailureAction({ stage, error, interrupted: true })).toBe("retry");
    }
  });

  it("keeps retrying other settings failures", () => {
    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: overTheWire(new Error("Thread is gone")),
        interrupted: false,
      }),
    ).toBe("retry");
  });

  it("shows the server's sentence for a routine on a machine with rules", () => {
    expect(routineFailureText({ teamRules: active() }, new TypeError("Refused."))).toBe("Refused.");
  });
});
