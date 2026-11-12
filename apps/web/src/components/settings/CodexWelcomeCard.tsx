import { Children, type ReactNode } from "react";

import { useTx } from "../../i18n";
import { onboardingAgentUses } from "../../onboarding/providerReadiness.logic";
import { OpenAI } from "../Icons";

/** The Codex row of the first-run Agents step: one line of state, at most one button. */
export function CodexWelcomeCard({
  title,
  description,
  control,
  secondaryControl,
  menu,
  children,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly control?: ReactNode;
  /** A quiet action beside the state or the button. */
  readonly secondaryControl?: ReactNode;
  readonly menu?: ReactNode;
  readonly children?: ReactNode;
}) {
  const tx = useTx();
  const footer = Children.toArray(children);
  return (
    <div
      className="rounded-lg border border-border bg-background px-4 py-3.5"
      data-agent-row="codex"
    >
      <div className="flex flex-wrap items-center gap-3">
        <OpenAI className="size-5 shrink-0 fill-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {tx(onboardingAgentUses("codex"))}
          </p>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</div>
        </div>
        {control || secondaryControl || menu ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 has-[button]:w-full sm:has-[button]:w-auto">
            {secondaryControl}
            {control}
            {menu}
          </div>
        ) : null}
      </div>
      {footer.length > 0 ? (
        <div className="mt-2 ml-8 flex flex-wrap items-center gap-2">{footer}</div>
      ) : null}
    </div>
  );
}
