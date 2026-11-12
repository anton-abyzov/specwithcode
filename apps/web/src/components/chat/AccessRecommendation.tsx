import type { EnvironmentId, ProjectId, RuntimeMode } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { XIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useT } from "../../i18n";
import { useLatestRef } from "../../hooks/useLatestRef";
import { useFullAccessRecommendation } from "../../onboarding/accessRecommendation";
import {
  shouldRecommendFullAccess,
  type FullAccessRecommendationInput,
} from "../../onboarding/accessRecommendation.logic";
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
  /** The access a new chat starts with here; a chip set by hand on one draft does not decide. */
  readonly newChatMode: RuntimeMode;
}

/**
 * The recommendation for a chat: its facts, and what Switch and Keep do. Switch
 * saves Full access as the default for new chats (the main machine's, which a
 * chat on another machine follows), then sets this chat, then offers Undo.
 */
export function useComposerAccessRecommendation({
  environmentId,
  projectId,
  chatKey,
  newChatMode,
  chatStarted,
  onChatModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  /** Which chat is open; Switch and Undo change a chat's access only while it stays open. */
  readonly chatKey: string;
  readonly newChatMode: RuntimeMode;
  readonly chatStarted: boolean;
  readonly onChatModeChange: (mode: RuntimeMode) => void;
}): ComposerAccessRecommendation {
  const t = useT();
  const recommendation = useFullAccessRecommendation();
  const settings = useEnvironment(environmentId)?.serverConfig?.settings ?? null;
  const settingsLoaded = settings !== null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const target = primaryEnvironmentId ?? environmentId;
  const projectSetsMode =
    settings !== null &&
    resolveProjectSettings(settings, projectId).sources.defaultRuntimeMode !== "environment";
  const { accept: acceptFor, decline, undo } = recommendation;
  // Undo runs after the chat has re-rendered on Full access, so it needs the newest handler.
  const onChatModeChangeRef = useLatestRef(onChatModeChange);
  const chatKeyRef = useLatestRef(chatKey);
  const accept = useCallback(
    async (chatMode: RuntimeMode) => {
      // The newest handler acts on whichever chat is open by then, so a chat the
      // person moved to meanwhile is left alone; new chats follow the saved default.
      const acceptedChat = chatKeyRef.current;
      const setChatMode = (mode: RuntimeMode) => {
        if (chatKeyRef.current === acceptedChat) onChatModeChangeRef.current(mode);
      };
      const previous = await acceptFor([target]);
      if (previous === null) return t("wizard.access.saveFailed");
      setChatMode("full-access");
      const toastId = toastManager.add({
        type: "success",
        title: t("wizard.access.onTitle"),
        description: t("wizard.access.onDescription"),
        actionProps: {
          children: t("wizard.access.undo"),
          onClick: () => {
            toastManager.close(toastId);
            void undo(previous).then((undone) => {
              if (undone) setChatMode(chatMode);
              else toastManager.add({ type: "error", title: t("wizard.access.undoFailed") });
            });
          },
        },
      });
      return null;
    },
    [acceptFor, chatKeyRef, onChatModeChangeRef, t, target, undo],
  );
  return useMemo(
    () => ({
      input: {
        answer: recommendation.answer,
        settingsKnown: recommendation.hydrated && settingsLoaded,
        machineRole: recommendation.machineRole,
        projectSetsMode,
        chatStarted,
      },
      accept,
      decline: () => void decline(),
      newChatMode,
    }),
    [
      accept,
      chatStarted,
      decline,
      newChatMode,
      projectSetsMode,
      recommendation.answer,
      recommendation.hydrated,
      recommendation.machineRole,
      settingsLoaded,
    ],
  );
}

/**
 * The recommendation when it applies to this composer, else null: the chat's
 * facts, plus the modes the chat's provider offers and whether team rules allow
 * Full access. Asked only while new chats start below Full access and this chat
 * is below it too, so a draft set to Supervised by hand on a Full access
 * machine is not asked to switch back.
 */
export function composerAccessRecommendationFor(
  recommendation: ComposerAccessRecommendation | undefined,
  chatMode: RuntimeMode,
  modeOptions: readonly { readonly mode: RuntimeMode; readonly aboveTeamLimit?: boolean }[],
): ComposerAccessRecommendation | null {
  if (recommendation === undefined) return null;
  const fullAccessOption = modeOptions.find((option) => option.mode === "full-access");
  return shouldRecommendFullAccess({
    ...recommendation.input,
    mode: recommendation.newChatMode === "full-access" ? "full-access" : chatMode,
    fullAccessOffered: fullAccessOption !== undefined,
    fullAccessAllowed: fullAccessOption !== undefined && fullAccessOption.aboveTeamLimit !== true,
  })
    ? recommendation
    : null;
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
 * A press outside the callout is not an answer: it puts the callout away for
 * the rest of this app session, in every chat, and the chip keeps its accent.
 * The callout opens again on the next launch until it is answered.
 */
let calloutPutAwayThisSession = false;

/** Forget a put-away callout, as a new app session would. For tests. */
export function resetAccessCalloutSession(): void {
  calloutPutAwayThisSession = false;
}

/** Focus stays where the person is typing; the callout only takes it from elsewhere. */
function isTextEntry(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element instanceof HTMLTextAreaElement) return true;
  return (
    element instanceof HTMLInputElement &&
    !["button", "checkbox", "radio", "submit", "reset"].includes(element.type)
  );
}

/**
 * The access chip while Full access is recommended: an accent ring and dot, and
 * the callout anchored to it. Escape, the close button and Keep decline; a
 * press elsewhere puts the callout away for this app session.
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
  const [putAway, setPutAway] = useState(() => calloutPutAwayThisSession);
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
          else if (details.reason === "outside-press") {
            calloutPutAwayThisSession = true;
            setPutAway(true);
          }
        }}
      >
        <PopoverPopup
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={10}
          width="md"
          initialFocus={() =>
            isTextEntry(document.activeElement) ? false : (primaryRef.current ?? true)
          }
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
