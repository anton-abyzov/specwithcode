import { describe, expect, it } from "vite-plus/test";

import { composerModelState, modelStateText } from "./ModelStateTag";

const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const opus1m = { instanceId: "claudeAgent", model: "claude-opus-5-5[1m]" };
const gemini = { instanceId: "acpRegistry_gemini", model: "default" };
const sol = { instanceId: "codex", model: "gpt-6.1-sol" };
const names: Record<string, string> = {
  "claudeAgent:claude-opus-5-5": "Claude Code · Opus 5.5",
  "claudeAgent:claude-opus-5-5[1m]": "Claude Code · Opus 5.5",
  "acpRegistry_gemini:default": "Gemini CLI · Default",
  "codex:gpt-6.1-sol": "Codex · GPT-6.1 Sol",
};
const label = (selection: { instanceId: string; model: string }) => {
  const full = names[`${selection.instanceId}:${selection.model}`] ?? selection.model;
  return { full, model: full.split(" · ").at(-1)! };
};
const state = (over: Partial<Parameters<typeof composerModelState>[0]>) =>
  composerModelState({
    shown: opus,
    running: null,
    thread: opus,
    fallbackFrom: null,
    label,
    ...over,
  });

describe("composerModelState", () => {
  it("adds nothing when the chip is the model that runs", () => {
    expect(state({})).toBeNull();
    expect(state({ running: opus })).toBeNull();
    // The provider reporting a variant slug of the same model is not another model.
    expect(state({ running: opus1m })).toBeNull();
  });

  it("names the running model when the chip shows the next message's pick", () => {
    expect(state({ shown: sol, running: opus })).toEqual({
      kind: "running",
      running: "Claude Code · Opus 5.5",
    });
  });

  it("marks a limit fallback against the model it stands in for", () => {
    const fallback = state({
      shown: gemini,
      thread: gemini,
      fallbackFrom: opus,
    });
    expect(fallback).toEqual({
      kind: "fallback",
      pick: "Claude Code · Opus 5.5",
      pickModel: "Opus 5.5",
      reason: "usage limit",
    });
    expect(modelStateText(fallback!)).toEqual({
      label: "Fallback for Opus 5.5",
      tip: "Runs on this model instead of your pick, Claude Code · Opus 5.5 (usage limit).",
    });
    // While the fallback turn runs, the chip and the run agree: still a fallback.
    expect(
      state({ shown: gemini, thread: gemini, running: gemini, fallbackFrom: opus })?.kind,
    ).toBe("fallback");
  });

  it("drops the fallback mark once the chip shows a model picked by hand", () => {
    expect(state({ shown: sol, thread: gemini, fallbackFrom: opus })).toBeNull();
  });

  it("prefers the running turn over the fallback mark when they differ", () => {
    expect(state({ shown: sol, thread: gemini, running: gemini, fallbackFrom: opus })).toEqual({
      kind: "running",
      running: "Gemini CLI · Default",
    });
  });
});
