import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon, XIcon } from "lucide-react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  primaryServerConfigAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { Button } from "../ui/button";
import {
  providerCanRunWork,
  showWhatYouCanDo,
  whatYouCanDoItems,
  type WhatYouCanDoItem,
} from "./whatYouCanDo.logic";

/** Overview's checklist: reads the rest of what it ticks, and shows until dismissed or finished. */
export function WhatYouCanDo({
  known,
  hasProject,
  hasSession,
  hasOtherMachine,
  onNewSession,
}: {
  /** The workspace's projects and sessions have loaded. */
  readonly known: boolean;
  readonly hasProject: boolean;
  readonly hasSession: boolean;
  readonly hasOtherMachine: boolean;
  readonly onNewSession: () => void;
}) {
  const dismissed = useClientSettings((settings) => settings.whatYouCanDoDismissed);
  const settingsKnown = useClientSettingsHydrated();
  const updateClientSettings = useUpdateClientSettings();
  const config = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const routines = useEnvironmentQuery(
    !dismissed && primaryEnvironmentId !== null
      ? serverEnvironment.scheduledTasksLive({ environmentId: primaryEnvironmentId, input: {} })
      : null,
  );
  const items = whatYouCanDoItems({
    agentReady: providers.some(providerCanRunWork),
    hasProject,
    hasSession,
    hasRoutine: (routines.data?.tasks.length ?? 0) > 0,
    hasOtherMachine,
  });
  // A server that cannot list routines must not hold the checklist back for good.
  const routinesKnown = routines.data !== null || routines.error !== null;
  // With no server of its own (the hosted app), half of this could never tick.
  const allKnown =
    known && settingsKnown && primaryEnvironmentId !== null && config !== null && routinesKnown;
  if (!showWhatYouCanDo({ dismissed, known: allKnown, items })) return null;
  return (
    <WhatYouCanDoCard
      items={items}
      onDismiss={() => void updateClientSettings({ whatYouCanDoDismissed: true })}
      onNewSession={onNewSession}
    />
  );
}

/** The checklist itself. What it holds and whether it shows are the caller's. */
export function WhatYouCanDoCard({
  items,
  onDismiss,
  onNewSession,
}: {
  readonly items: readonly WhatYouCanDoItem[];
  readonly onDismiss: () => void;
  readonly onNewSession: () => void;
}) {
  const done = items.filter((item) => item.done).length;
  return (
    <section
      aria-labelledby="what-you-can-do-title"
      className="mb-4 rounded-xl border border-border bg-card text-card-foreground"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 id="what-you-can-do-title" className="text-sm font-medium">
          What you can do
        </h2>
        <span className="text-xs text-muted-foreground">
          {done} of {items.length} done
        </span>
        <span className="ms-auto text-xs text-muted-foreground max-sm:hidden">
          Bring it back in Settings &gt; General
        </span>
        <Button
          className="max-sm:ms-auto"
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Dismiss What you can do"
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>
      <ul className="divide-y divide-border/60">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 items-center gap-3 px-4 py-2">
            <span
              aria-hidden
              className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                item.done
                  ? "border-success bg-success text-background"
                  : "border-muted-foreground/50"
              }`}
            >
              {item.done ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm ${item.done ? "text-muted-foreground" : ""}`}>
                {item.title}
                {item.done ? <span className="sr-only"> (done)</span> : null}
              </span>
              {item.done ? null : (
                <span className="block text-xs text-muted-foreground">{item.detail}</span>
              )}
            </span>
            {item.done ? null : item.action.kind === "link" ? (
              <Button
                className="shrink-0"
                size="xs"
                variant="ghost-muted"
                render={<Link to={item.action.to} />}
              >
                {item.action.label}
                <ArrowRightIcon aria-hidden className="size-3" />
              </Button>
            ) : (
              <Button className="shrink-0" size="xs" variant="outline" onClick={onNewSession}>
                {item.action.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
