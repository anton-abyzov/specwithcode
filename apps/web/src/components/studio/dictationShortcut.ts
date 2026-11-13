import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { ResolvedKeybindingsConfig } from "@specweave-studio/contracts";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useClientSettings } from "../../hooks/useSettings";
import { resolveShortcutCommand } from "../../keybindings";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { isAppSheetOpen } from "../ui/appSheetState";

/** What a composer's dictation shows the shortcut and the other composers. */
export interface DictationControl {
  /** Stable for the composer's lifetime; the returned object itself changes every render. */
  readonly key: object;
  readonly available: boolean;
  readonly active: boolean;
  readonly phase: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface Target {
  readonly root: RefObject<HTMLElement | null>;
  readonly control: () => DictationControl;
  readonly disabled: () => boolean;
  focusedAt: number;
}

/**
 * Every mounted composer with dictation. The coordinator and a thread can be on
 * screen together, and kept project pages stay mounted while hidden, so one
 * key press must reach exactly one of them.
 */
const targets = new Set<Target>();
let focusClock = 0;
const KEYBOARD_OWNER = '[role="application"]';
let liveCalls = 0;

/** A voice call shares the microphone grant with dictation; none starts while one runs. */
export function markVoiceCallLive(): () => void {
  liveCalls += 1;
  return () => {
    liveCalls = Math.max(0, liveCalls - 1);
  };
}

export function isVoiceCallLive(): boolean {
  return liveCalls > 0;
}

function visible(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && element.getClientRects().length > 0;
}

/**
 * The composer the shortcut is for: the one dictating, else the one holding
 * focus (which does nothing while blocked), else the visible one used last.
 */
export function pickDictationTarget(): Target | null {
  const candidates = [...targets].filter((target) => target.control().available);
  const dictating = candidates.find((target) => target.control().active);
  if (dictating) return dictating;
  const focus = document.activeElement;
  // A focused composer keeps the key even while blocked (an approval or a
  // choice-only question), so it never falls through to another composer.
  const focused = candidates.find(
    (target) => focus && visible(target.root.current) && target.root.current?.contains(focus),
  );
  if (focused) return focused;
  const shown = candidates.filter((target) => visible(target.root.current) && !target.disabled());
  return shown.sort((a, b) => b.focusedAt - a.focusedAt)[0] ?? null;
}

/** Stops dictation everywhere but `keep`: the desktop grants the microphone per window. */
export async function stopOtherDictation(keep: object): Promise<void> {
  await Promise.all(
    [...targets]
      .map((target) => target.control())
      .filter((control) => control.key !== keep && control.active)
      .map((control) => control.stop()),
  );
}

export function registerDictationTarget(target: Omit<Target, "focusedAt">): () => void {
  const entry: Target = { ...target, focusedAt: 0 };
  targets.add(entry);
  const onFocusIn = () => {
    entry.focusedAt = ++focusClock;
  };
  let observed: HTMLElement | null = null;
  // The root ref is filled on mount, after this registers.
  const attach = () => {
    const root = target.root.current;
    if (root === observed) return;
    observed?.removeEventListener("focusin", onFocusIn);
    observed = root;
    root?.addEventListener("focusin", onFocusIn);
    if (root?.contains(document.activeElement)) onFocusIn();
  };
  attach();
  const frame = typeof window === "undefined" ? 0 : window.requestAnimationFrame(attach);
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    observed?.removeEventListener("focusin", onFocusIn);
    targets.delete(entry);
  };
}

/** Test seam: forget every composer. */
export function resetDictationTargetsForTest(): void {
  targets.clear();
  liveCalls = 0;
  focusClock = 0;
}

/**
 * In Auto mode a press held this long is push-to-talk: letting go stops it.
 * A shorter tap leaves the microphone on until the next press.
 */
export const DICTATION_HOLD_MS = 400;

/**
 * The `composer.dictation.toggle` shortcut for one composer. Every composer
 * listens, and only the picked one acts, so the key never toggles twice. Auto
 * mode (the default) is push-to-talk when held and stays on after a tap; Toggle
 * mode starts and stops on each press; Hold mode dictates until a key is let go.
 * Where dictation cannot run the key is left alone for the browser.
 */
export function useDictationShortcut({
  dictation,
  root,
  keybindings,
  disabled = false,
}: {
  dictation: DictationControl;
  root: RefObject<HTMLElement | null>;
  keybindings: ResolvedKeybindingsConfig;
  disabled?: boolean;
}): void {
  const mode = useClientSettings((settings) => settings.dictationMode);
  const latest = useRef({ dictation, disabled, mode, keybindings });
  useLayoutEffect(() => {
    latest.current = { dictation, disabled, mode, keybindings };
  });

  useEffect(() => {
    const target = {
      root,
      control: () => latest.current.dictation,
      disabled: () => latest.current.disabled,
    };
    const unregister = registerDictationTarget(target);
    // When the press that started dictation went down, while its keys are still held.
    let pressedAt: number | null = null;
    // The keys of that press: its key and the modifiers held with it.
    let chord = new Set<string>();
    const release = () => {
      if (pressedAt === null) return;
      const heldFor = Date.now() - pressedAt;
      pressedAt = null;
      chord = new Set();
      // Auto: a quick tap leaves the microphone on, a longer hold was push-to-talk.
      if (latest.current.mode === "auto" && heldFor < DICTATION_HOLD_MS) return;
      // Already over (stopped after silence, or failed): leave its state and message alone.
      if (!latest.current.dictation.active) return;
      void latest.current.dictation.stop();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      // The palette, the model picker, a sheet or an embedded app owns the keys
      // over the composers; none of them may start a microphone out of sight.
      if (isCommandPaletteOpen() || isModelPickerOpen() || isAppSheetOpen()) return;
      if (
        event.composedPath().some((node) => node instanceof Element && node.matches(KEYBOARD_OWNER))
      )
        return;
      const command = resolveShortcutCommand(event, latest.current.keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (command !== "composer.dictation.toggle") return;
      const picked = pickDictationTarget();
      if (picked?.root !== root) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const { dictation: control, mode: currentMode } = latest.current;
      if (control.phase === "finishing") return;
      if (control.active) {
        pressedAt = null;
        void control.stop();
        return;
      }
      if (latest.current.disabled || isVoiceCallLive()) return;
      pressedAt = currentMode === "toggle" ? null : Date.now();
      chord = new Set([event.code]);
      if (event.ctrlKey) chord.add("Control");
      if (event.shiftKey) chord.add("Shift");
      if (event.altKey) chord.add("Alt");
      if (event.metaKey) chord.add("Meta");
      void control.start();
    };
    // Letting go of any key in the chord ends a held dictation, and so does leaving the window.
    // (In Auto mode only once the press lasted past DICTATION_HOLD_MS.)
    // A key typed just before the chord is let go after it went down; that is not the chord.
    const onKeyUp = (event: KeyboardEvent) => {
      if (chord.has(event.code) || chord.has(event.key)) release();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
      unregister();
    };
  }, [root]);
}
