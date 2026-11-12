import { useState } from "react";

import { useT } from "../../i18n";
import { FullAccessGlyph, SupervisedAccessGlyph } from "../chat/AccessGlyph";
import { FullAccessExplanation } from "./FullAccessExplanation";
import { StepShell, WizardStepFooter } from "./WizardFrame";

/**
 * The Access step of first-run setup: recommends Full access, says what it
 * allows and what still stops, and describes Supervised in one sentence. Each
 * answer is one press. A failed save keeps the step open and records nothing.
 */
export function AccessStep({
  keepsSupervised,
  onBack,
  onAccept,
  onDecline,
}: {
  /** New chats on these machines start Supervised; otherwise on another mode below Full access. */
  readonly keepsSupervised: boolean;
  readonly onBack: () => void;
  /** Saves Full access on each machine being set up; resolves to an error message when that failed. */
  readonly onAccept: () => Promise<string | null>;
  /** Records the answer; resolves to an error message when something could not be saved. */
  readonly onDecline: () => Promise<string | null>;
}) {
  const t = useT();
  const [saving, setSaving] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (choice: "accept" | "decline") => {
    if (saving !== null) return;
    setSaving(choice);
    setError(null);
    try {
      setError(await (choice === "accept" ? onAccept() : onDecline()));
    } catch {
      setError(t("wizard.access.saveFailed"));
    } finally {
      setSaving(null);
    }
  };
  return (
    <StepShell title={t("wizard.access.title")} description={t("wizard.access.description")}>
      <section
        aria-labelledby="first-run-full-access"
        data-recommended=""
        className="mt-5 rounded-xl border border-primary/60 bg-card p-4 ring-3 ring-primary/15"
      >
        <div className="flex flex-wrap items-center gap-2">
          <FullAccessGlyph aria-hidden className="size-4 shrink-0 text-foreground" />
          <h2 id="first-run-full-access" className="text-sm font-semibold text-foreground">
            {t("wizard.access.fullAccess")}
          </h2>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {t("wizard.access.recommended")}
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t("wizard.access.allowsIntro")}
        </p>
        <FullAccessExplanation className="mt-3" />
      </section>
      <section
        aria-labelledby="first-run-supervised"
        className="mt-3 flex items-start gap-3 rounded-xl border border-border bg-card p-4"
      >
        <SupervisedAccessGlyph aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          <h2 id="first-run-supervised" className="text-sm font-semibold text-foreground">
            {t("wizard.access.supervised")}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t("wizard.access.supervisedDescription")}
          </p>
        </div>
      </section>
      <p className="mt-3 text-xs text-muted-foreground">{t("wizard.access.askedOnce")}</p>
      <WizardStepFooter
        back={{ onClick: onBack, disabled: saving !== null }}
        skip={{
          label: t(keepsSupervised ? "wizard.access.keepSupervised" : "wizard.access.keepCurrent"),
          onClick: () => void answer("decline"),
          disabled: saving !== null,
        }}
        primary={{
          label: saving === "accept" ? t("wizard.access.saving") : t("wizard.access.use"),
          busy: saving !== null,
          onClick: () => void answer("accept"),
        }}
        error={error}
      />
    </StepShell>
  );
}
