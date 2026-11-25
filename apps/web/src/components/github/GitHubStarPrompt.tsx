/**
 * The in-app "Star on GitHub" card (1489).
 *
 * It asks after real use and only in a quiet moment, at most three times across all of the
 * person's machines, and never again after a star, an "Already starred" or Settings > About's
 * switch. "Star on GitHub" opens the repository in the browser so the person stars it as
 * themselves; the app never stars for anyone. Before showing, this machine's own GitHub sign-in
 * is asked, read-only, whether it already starred. The state is one shared server setting; use
 * counts stay on this device.
 */
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { mergeGitHubStarPrompt } from "@specweave-studio/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { gitHubCredential } from "../../studio/gitHubCredentialCopy";
import { GitHubStarPromptCard } from "./GitHubStarPromptCard";
import {
  answerStarPrompt,
  isStarPromptDue,
  noteStartedTurn,
  STAR_PROMPT_QUIET_MS,
} from "./githubStarPrompt.logic";
import { openRepository } from "./StarOnGitHub";

/** Called where a composer turn starts; counts the thread toward the first ask. */
export function noteStarPromptTurn(threadKey: string): void {
  const now = Date.now();
  // Counted from the saved values, never from the defaults that stand in before they load.
  void ensureClientSettingsHydrated()
    .then(() => {
      const next = noteStartedTurn(getClientSettings().githubStarUsage, threadKey, now);
      if (next !== null) void persistClientSettingsPatch({ githubStarUsage: next });
    })
    .catch(() => undefined);
}

/** Runs `work` and reports whether the window stayed focused and untouched meanwhile. */
async function stayedQuietDuring<A>(work: () => Promise<A>): Promise<{ value: A; quiet: boolean }> {
  let touched = false;
  const touch = () => {
    touched = true;
  };
  for (const name of QUIET_EVENTS) window.addEventListener(name, touch, true);
  try {
    const value = await work();
    return {
      value,
      quiet: !touched && document.visibilityState === "visible" && document.hasFocus(),
    };
  } finally {
    for (const name of QUIET_EVENTS) window.removeEventListener(name, touch, true);
  }
}

const QUIET_EVENTS = ["pointerdown", "keydown", "wheel", "focus"] as const;

/** Resolves after the window has been focused, visible and untouched for `quietMs`. */
function waitForQuietMoment(quietMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === "visible" && document.hasFocus()) {
          cleanup();
          resolve();
        } else {
          restart();
        }
      }, quietMs);
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const name of QUIET_EVENTS) window.removeEventListener(name, restart, true);
    };
    for (const name of QUIET_EVENTS) window.addEventListener(name, restart, true);
    signal.addEventListener("abort", cleanup, { once: true });
    restart();
  });
}

export function GitHubStarPromptHost() {
  const available = usePrimarySettingsAvailable();
  const environmentId = usePrimaryEnvironmentId();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const clientHydrated = useClientSettingsHydrated();
  const primaryPrompt = usePrimarySettings((settings) => settings.githubStarPrompt);
  const { environments } = useEnvironments();
  // Every connected machine's answer counts, so one that missed a write cannot ask again.
  const prompt = useMemo(
    () =>
      environments.reduce((merged, environment) => {
        const other = environment.serverConfig?.settings?.githubStarPrompt;
        return other ? mergeGitHubStarPrompt(merged, other) : merged;
      }, primaryPrompt),
    [environments, primaryPrompt],
  );
  const usage = useClientSettings((settings) => settings.githubStarUsage);
  const updateSettings = useUpdatePrimarySettings();
  const readStarred = useAtomCommand(gitHubCredential.starred, { reportFailure: false });
  const [visible, setVisible] = useState(false);
  // One look per window: an answer that fails to save never turns into a loop.
  const lookedRef = useRef(false);

  // Until both sides are loaded the defaults read "asking", which is not the person's answer.
  const ready = available && environmentId !== null && serverConfig !== null && clientHydrated;
  const due = ready && isStarPromptDue(prompt, usage, Date.now());

  useEffect(() => {
    if (!due || lookedRef.current || environmentId === null) return;
    const controller = new AbortController();
    void (async () => {
      await waitForQuietMoment(STAR_PROMPT_QUIET_MS, controller.signal);
      if (controller.signal.aborted || lookedRef.current) return;
      lookedRef.current = true;
      const { value: result, quiet } = await stayedQuietDuring(() =>
        readStarred({ environmentId, input: {} }),
      );
      if (controller.signal.aborted) return;
      const now = Date.now();
      if (result._tag === "Success" && result.value.starred === true) {
        void updateSettings({ githubStarPrompt: answerStarPrompt(prompt, "detected", now) });
        return;
      }
      // The check can take seconds; never let the card land on someone who started typing.
      if (!quiet) await waitForQuietMoment(STAR_PROMPT_QUIET_MS, controller.signal);
      if (controller.signal.aborted) return;
      // Saved before it shows, so a reload or an ignored card still uses up this ask.
      void updateSettings({ githubStarPrompt: answerStarPrompt(prompt, "shown", Date.now()) });
      setVisible(true);
    })();
    return () => controller.abort();
  }, [due, environmentId, prompt, readStarred, updateSettings]);

  const finish = useCallback(
    (starred: boolean) => {
      setVisible(false);
      if (starred) {
        void updateSettings({
          githubStarPrompt: answerStarPrompt(prompt, "already-starred", Date.now()),
        });
      }
    },
    [prompt, updateSettings],
  );

  if (!visible) return null;
  return (
    <GitHubStarPromptCard
      onStar={() => {
        openRepository();
        finish(true);
      }}
      onAlreadyStarred={() => finish(true)}
      onNotNow={() => finish(false)}
    />
  );
}
