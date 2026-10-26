/**
 * The state a model chip is in when the chip alone would mislead: a usage-limit
 * fallback runs instead of the model that was picked, the thread's saved model
 * takes over after this turn, or the next message goes to another model. It is a
 * quiet suffix inside the model unit (glyph, then words), never a peer pill, so the
 * running model's name always comes first. One language on every surface: an amber
 * switch-track glyph alone for a fallback (FallbackGlyph), muted ↳ for a pick that applies later, a green dot for a turn
 * that runs elsewhere. Hosts own the tooltip; see `ModelStateTip`.
 */
import { CornerDownRightIcon } from "lucide-react";
import { FallbackGlyph } from "./FallbackGlyph";
import { cn } from "~/lib/utils";

export type ModelState =
  /** The thread is saved on `pick`; this turn runs on the model the chip shows. */
  | { readonly kind: "preferred"; readonly pick: string; readonly pickModel?: string }
  /** The next message goes to `pick`, picked by hand. */
  | { readonly kind: "next"; readonly pick: string; readonly pickModel?: string }
  /** The chip shows a fallback that stands in for the picked model. */
  | {
      readonly kind: "fallback";
      /** The picked model in full: `Claude Code · Opus 5.5`. */
      readonly pick: string;
      /**
       * The words that tell the pick apart from the running model: `Opus 5.5`, or the
       * pick's provider (`Codex`) when both run a model of the same name.
       */
      readonly pickModel: string;
      /** The running provider, set only when it runs a model named like the pick. */
      readonly via?: string;
      /** The thread started here because the pick had no room; no usage limit stopped it. */
      readonly launched?: true;
      readonly reason?: string | null;
      /** What the host knows beyond the shell: reset time, room again, the way back. */
      readonly detail?: string | null;
    }
  /** The chip shows the next message's pick; this turn still runs on `running`. */
  | { readonly kind: "running"; readonly running: string; readonly runningModel?: string };

type Selection = { readonly instanceId: string; readonly model: string };
type Label = {
  readonly provider: string;
  readonly model: string;
  readonly full: string;
  /** The provider instance's own name, which tells two accounts of one provider apart. */
  readonly instance?: string;
};

/**
 * `GPT-6.1 Sol`, `GPT-6.1-Sol` and `gpt-6-1-sol-medium` name one model, and so do
 * Claude Code's `Opus 5.5` and Copilot's `Claude Opus 5.5`. A placeholder such as
 * `default` or `auto` names no model, so it is never a twin.
 */
export function sameModelName(a: string, b: string): boolean {
  // Only a separated effort suffix is dropped: GPT-5.1-Codex-Max is not GPT-5.1-Codex.
  // A leading maker word is dropped too; GPT is not one, since GPT-6.1 is the model's name.
  const key = (name: string) =>
    name
      .toLowerCase()
      .trim()
      .replace(/[-_\s](xhigh|high|medium|low)$/, "")
      .replace(/^(claude|gemini|grok)[-_\s]+(?=\S)/, "")
      .replace(/[^a-z0-9]/g, "");
  const left = key(a);
  if (left === "" || left === "default" || left === "auto") return false;
  return left === key(b);
}

/**
 * A fallback state that never names one model twice: when the fallback runs a model
 * named like the pick (Devin's GPT-6.1 Sol for Codex's), the provider is the difference.
 */
export function fallbackModelState(input: {
  readonly pick: Label;
  readonly running: Label | null;
  readonly reason?: string | null;
  readonly detail?: string | null;
  readonly launched?: boolean;
}): Extract<ModelState, { kind: "fallback" }> {
  const { pick, running } = input;
  const sameName = running !== null && sameModelName(running.model, pick.model);
  // Another provider names the difference; two accounts of one provider, their own names.
  const names: readonly [string, string] | null = !sameName
    ? null
    : running.provider !== pick.provider
      ? [pick.provider, running.provider]
      : pick.instance && running.instance && pick.instance !== running.instance
        ? [pick.instance, running.instance]
        : null;
  return {
    kind: "fallback",
    // The full pick names its provider already; `via` names the running account.
    pick: pick.full,
    pickModel: names ? names[0] : pick.model,
    ...(names ? { via: names[1] } : {}),
    ...(input.launched ? { launched: true as const } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

/**
 * What a chat composer's chip needs beside it. Labels are compared, not slugs, so a
 * provider reporting `claude-opus-5-5[1m]` for `claude-opus-5-5` reads as the same model.
 */
export function composerModelState(input: {
  /** What the chip shows: the pick for the next message. */
  readonly shown: Selection;
  /** The model of the turn in progress, if one runs. */
  readonly running: Selection | null;
  /** The thread's own model, which a limit fallback moved. */
  readonly thread: Selection | null;
  /** The picked model a limit fallback stands in for. */
  readonly fallbackFrom: Selection | null;
  readonly label: (selection: Selection) => Label;
}): ModelState | null {
  const shown = input.label(input.shown).full;
  if (input.running && input.label(input.running).full !== shown) {
    const running = input.label(input.running);
    return { kind: "running", running: running.full, runningModel: running.model };
  }
  if (input.fallbackFrom && input.thread && input.thread.instanceId === input.shown.instanceId) {
    return fallbackModelState({
      pick: input.label(input.fallbackFrom),
      running: input.label(input.shown),
      reason: "usage limit",
    });
  }
  return null;
}

export interface ModelStateCopy {
  /** The suffix where there is room: `Fallback for Opus 5.5`. */
  readonly label: string;
  /** The suffix on a narrower line: `Fallback`. */
  readonly short: string;
  /** One sentence for a title or a test: what the state means. */
  readonly tip: string;
  /** Appended to the enclosing accessible name: `, fallback for Claude Code · Opus 5.5 (usage limit)`. */
  readonly aria: string;
  /** The tooltip's second line, beside the glyph. */
  readonly line2: string;
  /** The tooltip's third line: why, and what happens next. */
  readonly detail: string;
}

export function modelStateText(state: ModelState): ModelStateCopy {
  if (state.kind === "preferred") {
    const model = state.pickModel ?? state.pick;
    return {
      label: `then ${model}`,
      short: `then ${model}`,
      tip: `The thread is set to ${state.pick}. The active turn keeps the model shown in the chip.`,
      aria: `, saved model ${state.pick}`,
      line2: `Saved model: ${state.pick}`,
      detail: "This turn keeps the model shown; the next turn uses the saved one.",
    };
  }
  if (state.kind === "next") {
    const model = state.pickModel ?? state.pick;
    return {
      label: `next: ${model}`,
      short: "next",
      tip: `This turn keeps its active model. Your next message uses ${state.pick}.`,
      aria: `, next message uses ${state.pick}`,
      line2: `Next message: ${state.pick}`,
      detail: "This turn keeps its active model.",
    };
  }
  if (state.kind === "fallback") {
    const reason = state.launched ? "no room at launch" : (state.reason ?? "usage limit");
    // The tip stands alone, so it says which provider runs a same-named model.
    const through = state.via ? `, the same model through ${state.via}` : "";
    return {
      label: `Fallback for ${state.pickModel}`,
      short: "Fallback",
      tip: `Fallback: runs on this model instead of your pick, ${state.pick}${through}${state.launched || state.reason ? ` (${reason})` : ""}.`,
      aria: `, fallback for ${state.pick} (${reason})`,
      line2: `Fallback for your pick, ${state.pick}`,
      detail:
        state.detail ??
        (state.launched
          ? `${state.pickModel} had no room when this thread started. Open the thread to switch back.`
          : `${state.pickModel} hit its ${reason}. Open the thread to switch back.`),
    };
  }
  const model = state.runningModel ?? state.running;
  return {
    label: `this turn: ${model}`,
    short: "this turn",
    tip: `This turn runs on ${state.running}. Your pick applies from the next message.`,
    aria: `, this turn runs on ${state.running}`,
    line2: `This turn: ${state.running}`,
    detail: "Your pick applies from the next message.",
  };
}

/**
 * The suffix. A fallback shows its glyph alone unless `fit` asks for words. For the
 * other kinds the host decides how much shows by width: `.sws-model-state-full` by
 * default, `.sws-model-state-short` on a narrower line (`data-fit="short"` or a
 * container rule), the glyph alone at the narrowest (`data-fit="glyph"`). Inside a
 * model chip (`chip`) the words are chip parts and the chip's fit decides instead
 * (modelChipFit.ts). The sentence for screen readers is present at every width.
 */
export function ModelStateTag(props: {
  state: ModelState;
  className?: string;
  /** Width tiers for this host, such as container-query classes. */
  tierClassName?: string;
  /** Fix the width tier instead of leaving it to the host's container rules. */
  fit?: "full" | "short" | "glyph";
  /** The words are parts of an enclosing model chip, which picks what shows. */
  chip?: boolean;
}) {
  const text = modelStateText(props.state);
  const kind = props.state.kind;
  // A fallback is its glyph alone: the model it runs on keeps the room, and the
  // tooltip and the accessible name say what it stands in for.
  const textual = kind !== "fallback" || props.fit === "full" || props.fit === "short";
  return (
    <span
      className={cn("sws-model-state", props.tierClassName, props.className)}
      data-model-state={kind}
      data-tone={kind === "fallback" ? "warning" : "muted"}
      {...(props.fit ? { "data-fit": props.fit } : {})}
    >
      {kind === "running" ? (
        <span aria-hidden className="sws-model-state-dot" data-pulse />
      ) : kind === "fallback" ? (
        // text-current: hosts such as the composer trigger mute every unclassed icon.
        <FallbackGlyph className="sws-model-state-glyph text-current" />
      ) : (
        <CornerDownRightIcon aria-hidden />
      )}
      {textual ? (
        <>
          <span
            className="sws-model-state-full"
            aria-hidden
            {...(props.chip ? { "data-model-chip-part": "state-full" } : {})}
          >
            {text.label}
          </span>
          <span
            className="sws-model-state-short"
            aria-hidden
            {...(props.chip ? { "data-model-chip-part": "state-short" } : {})}
          >
            {text.short}
          </span>
        </>
      ) : null}
      <span className="sr-only">{text.aria}</span>
    </span>
  );
}

/**
 * The same three lines on every surface: the running model (and its usage, where the
 * host knows it), the state beside its glyph, and why or what next.
 */
export function ModelStateTip(props: {
  /** The running model in full: `Codex · GPT-6.1-Sol`. */
  current: string;
  /** Appended to the first line, such as ` · 27% used`. */
  currentNote?: string | null;
  /** The provider connection that runs it, when it says more than the provider: `Codex Work`. */
  connection?: string | null;
  state: ModelState;
}) {
  const text = modelStateText(props.state);
  const kind = props.state.kind;
  return (
    <span className="sws-model-state-tip">
      <strong>
        {props.current}
        {props.currentNote ?? ""}
      </strong>
      {props.connection ? (
        <span className="sws-model-state-tip-detail">Connection: {props.connection}</span>
      ) : null}
      <span
        className="sws-model-state-tip-line"
        data-tone={kind === "fallback" ? "warning" : "muted"}
      >
        {kind === "running" ? (
          <span aria-hidden className="sws-model-state-dot" />
        ) : kind === "fallback" ? (
          <FallbackGlyph />
        ) : (
          <CornerDownRightIcon aria-hidden />
        )}
        {text.line2}
      </span>
      <span className="sws-model-state-tip-detail">{text.detail}</span>
    </span>
  );
}
