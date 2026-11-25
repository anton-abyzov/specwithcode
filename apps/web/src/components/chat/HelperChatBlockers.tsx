/**
 * Helpers this thread started on other machines that are blocked. Such a
 * helper reports back here, and lists do not count it on its own, so this
 * thread shows what it waits on, with a way to open it. A subagent's helpers
 * also show in its root thread.
 */
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { HandIcon } from "lucide-react";
import { useMemo } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { useOpenThread } from "../../hooks/useOpenThread";
import { useThreadShells } from "../../state/entities";
import { threadOwnBlocker } from "../../studio/projectWorkspaceModel";
import { blockedHelpersOf } from "../../studio/standaloneChats";
import { InlineButton } from "../ui/button";

export function HelperChatBlockers({ thread }: { thread: EnvironmentThreadShell | null }) {
  const tx = useTx();
  const { openThread } = useOpenThread();
  // Only a thread's own page reads every shell; nothing renders while none is blocked.
  const shells = useThreadShells(thread !== null);
  const blocked = useMemo(() => {
    if (thread === null) return [];
    const byKey = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
    return blockedHelpersOf(thread, shells, {
      thread: (key) => byKey.get(key),
      blockerOf: threadOwnBlocker,
    });
  }, [shells, thread]);
  if (blocked.length === 0) return null;
  return (
    <section
      className="pointer-events-auto mx-auto mt-1 flex w-full max-w-3xl flex-col gap-1 rounded-xl border border-warning/40 lane-surface px-3 py-1.5 text-sm shadow-xs [--lane-tint:color-mix(in_srgb,var(--warning)_8%,transparent)] dark:[--lane-tint:color-mix(in_srgb,var(--warning)_16%,transparent)]"
      aria-label={tx("Helpers on other machines are blocked")}
      data-helper-chat-blockers
    >
      {blocked.map(({ helper, blocker }) => (
        <div key={`${helper.environmentId}:${helper.id}`} className="flex items-start gap-2">
          <HandIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
          <p className="line-clamp-2 min-w-0 flex-1 break-words text-foreground/90">
            <span className="font-medium text-warning-foreground">
              {renderRich(tx("{title} is blocked:"), { title: helper.title })}{" "}
            </span>
            {blocker}
          </p>
          <span className="mt-0.5 shrink-0 text-xs">
            <InlineButton
              tone="muted"
              onClick={() => void openThread(scopeThreadRef(helper.environmentId, helper.id))}
            >
              {tx("Open")}
            </InlineButton>
          </span>
        </div>
      ))}
    </section>
  );
}
