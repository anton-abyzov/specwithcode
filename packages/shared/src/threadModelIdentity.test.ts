import type { ModelSelection } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  baseModelSlug,
  launchFallbackAfterMove,
  limitFallbackPairing,
  limitPreswitchAfterMove,
  preswitchWindowResetAt,
  sameRunModel,
  threadModelIdentity,
} from "./threadModelIdentity.ts";

const sol = { instanceId: "codex", model: "gpt-6.1-sol" };
const astra = { instanceId: "codex", model: "gpt-6-astra" };
const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const runs = [
  { id: "run:1", modelSelection: sol },
  { id: "run:2", modelSelection: astra },
];
const messages = [{ id: "limit-fallback:thread:run:1", runId: "run:2" }];

describe("limitFallbackPairing", () => {
  it("pairs a fallback to another model on the same provider", () => {
    expect(limitFallbackPairing(messages, runs, astra)).toEqual({
      original: sol,
      stoppedRunId: "run:1",
    });
  });

  it("puts a recorded pre-switch before the continuation it followed", () => {
    const preswitchFrom = { modelSelection: opus, commandId: "limit-preswitch:thread:1:open" };
    expect(limitFallbackPairing(messages, runs, astra, null, preswitchFrom)).toEqual({
      original: opus,
      stoppedRunId: preswitchFrom.commandId,
      preswitched: true,
    });
  });

  it("treats a variant slug of the picked model as home", () => {
    expect(limitFallbackPairing(messages, runs, { ...sol, model: "gpt-6.1-sol[1m]" })).toBeNull();
  });

  it("ends once a later run goes back to the picked model", () => {
    expect(
      limitFallbackPairing(messages, [...runs, { id: "run:3", modelSelection: sol }], astra),
    ).toBeNull();
  });

  it("still pairs a fallback to another provider", () => {
    expect(
      limitFallbackPairing(messages, [runs[0]!, { id: "run:2", modelSelection: opus }], opus)
        ?.original,
    ).toEqual(sol);
  });
});

describe("launch fallback pairing", () => {
  const devinSol = { instanceId: "devin", model: "gpt-6.1-sol" };
  const launched = [{ id: "run:1", modelSelection: devinSol }];

  it("pairs a thread that started on a stand-in with the model it stands in for", () => {
    expect(limitFallbackPairing([], launched, devinSol, sol)).toEqual({
      original: sol,
      stoppedRunId: "launch:codex:gpt-6.1-sol",
      launched: true,
    });
    expect(
      threadModelIdentity({
        thread: devinSol as ModelSelection,
        fallbackFrom: (limitFallbackPairing([], launched, devinSol, sol)?.original ??
          null) as ModelSelection | null,
        launched: true,
      }),
    ).toEqual({ current: devinSol, preferred: sol, kind: "fallback", launched: true });
    // A usage-limit pairing never says it dates from the launch.
    expect(limitFallbackPairing(messages, runs, astra)?.launched).toBeUndefined();
  });

  it("ends once a run goes to the original model", () => {
    expect(
      limitFallbackPairing(
        [],
        [...launched, { id: "run:2", modelSelection: { ...sol, model: "gpt-6.1-sol[1m]" } }],
        devinSol,
        sol,
      ),
    ).toBeNull();
  });

  it("ends once the thread's next turn is set back on the original model", () => {
    expect(limitFallbackPairing([], launched, sol, sol)).toBeNull();
  });

  it("keeps a usage-limit continuation first", () => {
    expect(limitFallbackPairing(messages, runs, astra, opus)?.original).toEqual(sol);
    expect(limitFallbackPairing([], launched, devinSol, null)).toBeNull();
  });
});

describe("launch stand-in on a set model", () => {
  const devinSol = { instanceId: "devin", model: "gpt-6.1-sol" };
  const launched = [{ id: "run:1", modelSelection: devinSol }];
  it("holds on another model the server moved it to", () => {
    expect(limitFallbackPairing([], launched, opus, sol)?.original).toEqual(sol);
  });
  it("holds after a server move away and back to the launch model", () => {
    const away = [...launched, { id: "run:2", modelSelection: opus }];
    expect(limitFallbackPairing([], away, devinSol, sol)?.original).toEqual(sol);
  });
  it("holds before the first run, on the selection it launched with", () => {
    expect(limitFallbackPairing([], [], devinSol, sol)?.original).toEqual(sol);
  });
});

describe("launchFallbackAfterMove", () => {
  const devinSol = { instanceId: "devin", model: "gpt-6.1-sol" };
  it("keeps the stand-in through a server move", () => {
    expect(launchFallbackAfterMove(sol, devinSol, opus, true)).toBe(sol);
  });
  it("clears it on a pick of another model by a user or agent", () => {
    expect(launchFallbackAfterMove(sol, devinSol, opus, false)).toBeNull();
    // Even a pick of the original model itself: the thread is no longer a stand-in.
    expect(launchFallbackAfterMove(sol, devinSol, sol, false)).toBeNull();
  });
  it("keeps it when the change stays on the same model", () => {
    expect(
      launchFallbackAfterMove(sol, devinSol, { ...devinSol, model: "gpt-6.1-sol[1m]" }, false),
    ).toBe(sol);
  });
  it("gives null or undefined back for a thread that stands in for nothing", () => {
    expect(launchFallbackAfterMove(null, devinSol, opus, false)).toBeNull();
    expect(launchFallbackAfterMove(null, devinSol, opus, true)).toBeNull();
    expect(launchFallbackAfterMove(undefined, devinSol, opus, false)).toBeUndefined();
  });
});

describe("sameRunModel", () => {
  it("compares instance and base slug", () => {
    expect(baseModelSlug("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(sameRunModel(opus, { ...opus, model: "claude-opus-5-5[1m]" })).toBe(true);
    expect(sameRunModel(sol, astra)).toBe(false);
  });
});

describe("limitPreswitchAfterMove", () => {
  const preswitch = "limit-preswitch:thread:1:codex:2026-10-26T15:00:00.000Z";
  const origin = { modelSelection: sol, commandId: preswitch, resetAt: "2026-10-26T15:00:00.000Z" };

  it("reads the window reset a pre-switch id ends with", () => {
    expect(preswitchWindowResetAt(preswitch)).toBe("2026-10-26T15:00:00.000Z");
    expect(preswitchWindowResetAt("limit-preswitch:thread:1:codex:open")).toBeNull();
  });

  it("records where the pre-switch moved the thread from", () => {
    expect(limitPreswitchAfterMove(null, sol, astra, true, preswitch)).toEqual(origin);
  });

  it("keeps the first origin through a later pre-switch and other server moves", () => {
    expect(limitPreswitchAfterMove(origin, astra, opus, true, "limit-preswitch:x:open")).toBe(
      origin,
    );
    expect(limitPreswitchAfterMove(origin, astra, opus, true)).toBe(origin);
  });

  it("ends on a move back to the origin or on a pick", () => {
    expect(limitPreswitchAfterMove(origin, astra, sol, true)).toBeNull();
    expect(limitPreswitchAfterMove(origin, astra, opus, false)).toBeNull();
    expect(limitPreswitchAfterMove(origin, astra, astra, false)).toBe(origin);
    expect(limitPreswitchAfterMove(undefined, sol, astra, false)).toBeUndefined();
  });
});
