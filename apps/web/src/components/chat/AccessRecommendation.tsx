import type { EnvironmentId, ProjectId, RuntimeMode } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { XIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useT } from "../../i18n";
import { useLatestRef } from "../../hooks/useLatestRef";
import { useFullAccessRecommendation } from "../../onboarding/accessRecommendation";
import type { FullAccessRecommendationInput } from "../../onboarding/accessRecommendation.logic";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { FullAccessExplanation } from "../onboarding/FullAccessExplanation";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { FullAccessGlyph } from "./AccessGlyph";

/** What the composer's access chip needs to recommend Full access. */
export interface ComposerAccessRecommendation {
  /** The facts the chat itself knows; the composer adds the provider's modes and team rules. */
  readonly input: Omit<
    FullAccessRecommendationInput,
    "mode" | "fullAccessAllowed" | "fullAccessOffered"
  >;
  /** Full access for this chat and new chats. Resolves to an error message when it was not saved. */
  readonly accept: (chatMode: RuntimeMode) => Promise<string | null>;
  readonly decline: () => void;
}

/**
 * The recommendation for a chat: its facts, and what Switch and Keep do. Switch
 * saves Full access as the default for new chats (the main machine's, which a
 * chat on another machine follows), then sets this chat, then offers Undo.
 */
export function useComposerAccessRecommendation({
  environmentId,
  projectId,
  chatStarted,
  onChatModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly chatStarted: boolean;
  readonly onChatModeChange: (mode: RuntimeMode) => void;
}): ComposerAccessRecommendation {
  const t = useT();
  const recommendation = useFullAccessRecommendation();
  const settings = useEnvironment(environmentId)?.serverConfig?.settings ?? null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const target = primaryEnvironmentId ?? environmentId;
  const projectSetsMode =
    settings !== null &&
    resolveProjectSettings(settings, projectId).sources.defaultRuntimeMode !== "environment";
  const { accept: acceptFor, decline, undo } = recommendation;
  // Undo runs after the chat has re-rendered on Full access, so it needs the newest handler.
  const onChatModeChangeRef = useLatestRef(onChatModeChange);
  const accept = useCallback(
    async (chatMode: RuntimeMode) => {
      const previous = await acceptFor([target]);
      if (previous === null) return t("wizard.access.saveFailed");
      onChatModeChangeRef.current("full-access");
      const toastId = toastManager.add({
        type: "success",
        title: t("wizard.access.onTitle"),
        description: t("wizard.access.onDescription"),
        actionProps: {
          children: t("wizard.access.undo"),
          onClick: () => {
            toastManager.close(toastId);
            void undo(previous).then((undone) => {
              if (undone) onChatModeChangeRef.current(chatMode);
              else toastManager.add({ type: "error", title: t("wizard.access.undoFailed") });
            });
          },
        },
      });
      return null;
    },
    [acceptFor, onChatModeChangeRef, t, target, undo],
  );
  return useMemo(
    () => ({
      input: {
        answer: recommendation.answer,
        settingsKnown: recommendation.hydrated && settings !== null,
        machineRole: recommendation.machineRole,
        projectSetsMode,
        chatStarted,
      },
      accept,
      decline: () => void decline(),
    }),
    [
      accept,
      chatStarted,
      decline,
      projectSetsMode,
      recommendation.answer,
      recommendation.hydrated,
      recommendation.machineRole,
      settings,
    ],
  );
}

/** The callout's content: the shared explanation and its two answers. */
export function AccessRecommendationCallout({
  keepsSupervised,
  busy,
  error,
  primaryRef,
  onAccept,
  onDecline,
}: {
  readonly keepsSupervised: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly primaryRef?: React.Ref<HTMLButtonElement>;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}) {
  const t = useT();
  return (
    <div data-slot="access-recommendation" className="grid gap-3 pe-6 text-sm">
      <div className="flex items-center gap-2">
        <FullAccessGlyph aria-hidden className="size-4 shrink-0 text-primary" />
        <h2 className="font-semibold text-foreground">{t("wizard.access.calloutTitle")}</h2>
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        className="absolute end-2 top-2"
        aria-label={t("wizard.access.close")}
        title={t("wizard.access.close")}
        disabled={busy}
        onClick={onDecline}
      >
        <XIcon aria-hidden />
      </Button>
      <p className="leading-relaxed text-muted-foreground">
        {t(
          keepsSupervised
            ? "wizard.access.calloutIntroSupervised"
            : "wizard.access.calloutIntroOther",
        )}
      </p>
      <FullAccessExplanation />
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button ref={primaryRef} size="sm" disabled={busy} onClick={onAccept}>
          {busy ? t("wizard.access.saving") : t("wizard.access.switch")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onDecline}>
          {t(keepsSupervised ? "wizard.access.keepSupervised" : "wizard.access.keepCurrent")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("wizard.access.calloutNote")}
      </p>
    </div>
  );
}

/**
 * The access chip while Full access is recommended: an accent ring and dot, and
 * the callout anchored to it. Escape, the close button and Keep decline; a
 * press elsewhere only puts the callout away until the composer opens again.
 */
export function AccessRecommendationAnchor({
  mode,
  hidden,
  recommendation,
  children,
}: {
  /** The chat's access now. */
  readonly mode: RuntimeMode;
  /** The chip is folded away; the callout waits until it shows. */
  readonly hidden: boolean;
  readonly recommendation: Pick<ComposerAccessRecommendation, "accept" | "decline">;
  readonly children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [putAway, setPutAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setError(await recommendation.accept(mode));
    } finally {
      setBusy(false);
    }
  };
  const decline = () => {
    if (!busy) recommendation.decline();
  };
  return (
    <span
      ref={setAnchor}
      data-access-recommended=""
      className="relative inline-flex shrink-0 items-center rounded-md ring-2 ring-primary/70"
    >
      {children}
      <span
        aria-hidden
        data-slot="access-recommended-dot"
        className="pointer-events-none absolute -end-1 -top-1 size-2 rounded-full bg-primary ring-2 ring-background"
      />
      <Popover
        open={!hidden && !putAway && anchor !== null}
        onOpenChange={(open, details) => {
          if (open) return;
          if (details.reason === "escape-key") decline();
          else if (details.reason === "outside-press") setPutAway(true);
        }}
      >
        <PopoverPopup
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={10}
          width="md"
          initialFocus={primaryRef}
          finalFocus={false}
          className="w-[min(24rem,calc(100vw-2rem))]"
        >
          <AccessRecommendationCallout
            keepsSupervised={mode === "approval-required"}
            busy={busy}
            error={error}
            primaryRef={primaryRef}
            onAccept={() => void accept()}
            onDecline={decline}
          />
        </PopoverPopup>
      </Popover>
    </span>
  );
}
