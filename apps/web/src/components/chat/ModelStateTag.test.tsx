import { describe, expect, it } from "vite-plus/test";

import { renderToStaticMarkup } from "react-dom/server";
import {
  composerModelState,
  fallbackModelState,
  modelStateText,
  sameModelName,
  ModelStateTag,
  type ModelState,
} from "./ModelStateTag";

const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const opus1m = { instanceId: "claudeAgent", model: "claude-opus-5-5[1m]" };
const gemini = { instanceId: "acpRegistry_gemini", model: "default" };
const sol = { instanceId: "codex", model: "gpt-6.1-sol" };
const devinSol = { instanceId: "acpRegistry_devin", model: "gpt-6-1-sol-medium" };
const names: Record<string, string> = {
  "claudeAgent:claude-opus-5-5": "Claude Code · Opus 5.5",
  "claudeAgent:claude-opus-5-5[1m]": "Claude Code · Opus 5.5",
  "acpRegistry_gemini:default": "Gemini CLI · Default",
  "codex:gpt-6.1-sol": "Codex · GPT-6.1 Sol",
  "acpRegistry_devin:gpt-6-1-sol-medium": "Devin · GPT-6.1 Sol",
};
const label = (selection: { instanceId: string; model: string }) => {
  const full = names[`${selection.instanceId}:${selection.model}`] ?? selection.model;
  return { full, provider: full.split(" · ")[0]!, model: full.split(" · ").at(-1)! };
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
      runningModel: "Opus 5.5",
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
    expect(modelStateText(fallback!)).toMatchObject({
      label: "Fallback for Opus 5.5",
      tip: "Fallback: runs on this model instead of your pick, Claude Code · Opus 5.5 (usage limit).",
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
      runningModel: "Default",
    });
  });
});

describe("ModelStateTag", () => {
  it.each<ModelState>([
    { kind: "fallback", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" },
    { kind: "preferred", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" },
    { kind: "next", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" },
    { kind: "running", running: "Codex · GPT-6.1-Sol", runningModel: "GPT-6.1-Sol" },
  ])("renders $kind as one quiet suffix with an accessible sentence", (state) => {
    const html = renderToStaticMarkup(<ModelStateTag state={state} />);
    const text = modelStateText(state);
    expect(html).toContain(`data-model-state="${state.kind}"`);
    // A fallback is its glyph alone; its words live in the tooltip and accessible name.
    const words = state.kind !== "fallback";
    expect(html.includes("sws-model-state-full")).toBe(words);
    expect(html.includes("sws-model-state-short")).toBe(words);
    expect(html).toContain(text.aria);
    expect(html).not.toMatch(/class="[^"]*border/);
    expect(html).toContain(state.kind === "running" ? "sws-model-state-dot" : "<svg");
  });
  it("shows fallback words only when the host asks for them", () => {
    const state = {
      kind: "fallback",
      pick: "Claude Code · Opus 5.5",
      pickModel: "Opus 5.5",
    } as const;
    const glyph = renderToStaticMarkup(<ModelStateTag state={state} />);
    expect(glyph).toContain("data-fallback-glyph");
    expect(glyph).not.toContain("Fallback for Opus 5.5");
    expect(renderToStaticMarkup(<ModelStateTag state={state} fit="full" />)).toContain(
      "Fallback for Opus 5.5",
    );
  });
  it("keeps the fallback reason and way back in the tooltip", () => {
    expect(
      modelStateText({ kind: "fallback", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" }),
    ).toMatchObject({
      aria: ", fallback for Claude Code · Opus 5.5 (usage limit)",
      line2: "Fallback for your pick, Claude Code · Opus 5.5",
      detail: "Opus 5.5 hit its usage limit. Open the thread to switch back.",
    });
  });
  it("says a pre-switched pick neared its limit, and leaves out the way back in the open thread", () => {
    const pick = { full: "Claude Code · Opus 5.5", provider: "Claude Code", model: "Opus 5.5" };
    const running = { full: "Codex · GPT-6-Astra", provider: "Codex", model: "GPT-6-Astra" };
    const preswitched = fallbackModelState({
      pick,
      running,
      reason: "usage limit",
      preswitched: true,
    });
    expect(modelStateText(preswitched)).toMatchObject({
      tip: "Fallback: runs on this model instead of your pick, Claude Code · Opus 5.5 (near its usage limit).",
      aria: ", fallback for Claude Code · Opus 5.5 (near its usage limit)",
      detail:
        "Opus 5.5 neared its usage limit, so this thread moved before its next turn. Open the thread to switch back.",
    });
    const here = (launched: boolean) =>
      modelStateText(
        fallbackModelState({ pick, running, reason: "usage limit", launched, inOpenThread: true }),
      ).detail;
    expect(here(false)).toBe("Opus 5.5 hit its usage limit.");
    expect(here(true)).toBe("Opus 5.5 had no room when this thread started.");
    expect(
      modelStateText(fallbackModelState({ pick, running, preswitched: true, inOpenThread: true }))
        .detail,
    ).toBe("Opus 5.5 neared its usage limit, so this thread moved before its next turn.");
    // A launch fallback outranks a pre-switch, as in the composer.
    expect(
      modelStateText(fallbackModelState({ pick, running, launched: true, preswitched: true })).aria,
    ).toBe(", fallback for Claude Code · Opus 5.5 (no room at launch)");
  });
});

describe("ModelStateTag in a model chip", () => {
  it("marks its words as chip parts so the chip's fit decides what shows", () => {
    const markup = renderToStaticMarkup(
      <ModelStateTag
        state={{ kind: "next", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" }}
        chip
      />,
    );
    expect(markup).toContain('data-model-chip-part="state-full"');
    expect(markup).toContain('data-model-chip-part="state-short"');
    expect(markup).toContain(", next message uses Claude Code · Opus 5.5");
  });

  it("leaves other hosts' width tiers alone", () => {
    const markup = renderToStaticMarkup(
      <ModelStateTag state={{ kind: "next", pick: "Claude Code · Opus 5.5" }} />,
    );
    expect(markup).not.toContain("data-model-chip-part");
  });

  it("keeps a fallback to its glyph inside a chip", () => {
    const markup = renderToStaticMarkup(
      <ModelStateTag
        state={{ kind: "fallback", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" }}
        chip
      />,
    );
    expect(markup).not.toContain("data-model-chip-part");
    expect(markup).toContain(", fallback for Claude Code · Opus 5.5 (usage limit)");
  });
});

describe("fallback on a model of the same name", () => {
  it("names the pick's provider, not the model twice", () => {
    const fallback = state({ shown: devinSol, thread: devinSol, fallbackFrom: sol });
    expect(fallback).toEqual({
      kind: "fallback",
      pick: "Codex · GPT-6.1 Sol",
      pickModel: "Codex",
      via: "Devin",
      reason: "usage limit",
    });
    const text = modelStateText(fallback!);
    expect(text.label).toBe("Fallback for Codex");
    expect(text.line2).toBe("Fallback for your pick, Codex · GPT-6.1 Sol");
    expect(text.tip).toContain("the same model through Devin");
    expect(text.label).not.toContain("Sol");
  });

  it("keeps the model name when the models differ", () => {
    expect(
      fallbackModelState({
        pick: { provider: "Claude Code", model: "Opus 5.5", full: "Claude Code · Opus 5.5" },
        running: { provider: "Codex", model: "GPT-6.1 Sol", full: "Codex · GPT-6.1 Sol" },
      }),
    ).toEqual({ kind: "fallback", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" });
  });

  it("names the accounts when two accounts of one provider run the model", () => {
    const state = fallbackModelState({
      pick: {
        provider: "Codex",
        model: "GPT-6.1-Sol",
        full: "Codex · GPT-6.1-Sol",
        instance: "Codex",
      },
      running: {
        provider: "Codex",
        model: "GPT-6.1-Sol",
        full: "Codex · GPT-6.1-Sol",
        instance: "Codex (work)",
      },
    });
    expect(state).toMatchObject({
      pick: "Codex · GPT-6.1-Sol",
      pickModel: "Codex",
      via: "Codex (work)",
    });
    expect(modelStateText(state).label).toBe("Fallback for Codex");
    expect(modelStateText(state).tip).toBe(
      "Fallback: runs on this model instead of your pick, Codex · GPT-6.1-Sol, the same model through Codex (work).",
    );
  });

  it("says a launch fallback had no room, not that a limit stopped it", () => {
    const text = modelStateText(
      fallbackModelState({
        pick: { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" },
        running: { provider: "Claude Code", model: "Opus 5.5", full: "Claude Code · Opus 5.5" },
        reason: "usage limit",
        launched: true,
      }),
    );
    expect(text.detail).toBe(
      "GPT-6.1-Sol had no room when this thread started. Open the thread to switch back.",
    );
    expect(text.aria).toBe(", fallback for Codex · GPT-6.1-Sol (no room at launch)");
    expect(text.tip).not.toContain("usage limit");
  });

  it("reads catalogue names, slugs and effort suffixes as one model", () => {
    expect(sameModelName("GPT-6.1 Sol", "GPT-6.1-Sol")).toBe(true);
    expect(sameModelName("gpt-6-1-sol-medium", "GPT-6.1 Sol")).toBe(true);
    expect(sameModelName("GPT-6.1 Sol", "GPT-6 Astra")).toBe(false);
    expect(sameModelName("Opus 5.5", "Sonnet 5.5")).toBe(false);
    // Max is a model, not an effort.
    expect(sameModelName("GPT-5.1-Codex-Max", "GPT-5.1-Codex")).toBe(false);
    expect(sameModelName("gpt-6-1-sol-xhigh", "GPT-6.1-Sol")).toBe(true);
  });

  it("reads a maker word before the model name as the same model", () => {
    // Claude Code's name and Copilot's for one model.
    expect(sameModelName("Opus 5.5", "Claude Opus 5.5")).toBe(true);
    expect(sameModelName("claude-opus-5-5", "Opus 5.5")).toBe(true);
    expect(sameModelName("Gemini 3 Pro", "3 Pro")).toBe(true);
    // GPT is the model's own name, not a maker word.
    expect(sameModelName("GPT-6.1 Sol", "GPT-6.1-Sol")).toBe(true);
    expect(sameModelName("GPT-6.1 Sol", "6.1 Sol")).toBe(false);
    expect(sameModelName("Grok 5", "Grok 4")).toBe(false);
    expect(sameModelName("Claude Opus 5.5", "Claude Sonnet 5.5")).toBe(false);
  });

  it("never reads a placeholder as a twin", () => {
    expect(sameModelName("default", "default")).toBe(false);
    expect(sameModelName("Auto", "auto")).toBe(false);
    expect(sameModelName("", "")).toBe(false);
  });

  it("draws the switch-track glyph alone, with the fallback in the accessible name", () => {
    const html = renderToStaticMarkup(
      <ModelStateTag
        state={fallbackModelState({
          pick: { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" },
          running: { provider: "Devin", model: "GPT-6.1 Sol", full: "Devin · GPT-6.1 Sol" },
          reason: "usage limit",
        })}
      />,
    );
    expect(html).toContain("data-fallback-glyph");
    expect(html).not.toContain("sws-model-state-full");
    expect(html).toContain("fallback for Codex · GPT-6.1-Sol (usage limit)");
  });
});
