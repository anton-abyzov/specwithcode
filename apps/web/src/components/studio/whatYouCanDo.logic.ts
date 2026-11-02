/**
 * Overview's "What you can do": a short checklist ticked from what the workspace
 * really holds, so nothing is ticked by opening a page or reading about it.
 */

import type { ServerProvider } from "@specweave-studio/contracts";

export type WhatYouCanDoAction =
  | { readonly kind: "link"; readonly to: string; readonly label: string }
  | { readonly kind: "new-session"; readonly label: string };

export interface WhatYouCanDoItem {
  readonly id: "agent" | "project" | "session" | "routine" | "machine";
  readonly title: string;
  readonly detail: string;
  readonly done: boolean;
  readonly action: WhatYouCanDoAction;
}

export interface WhatYouCanDoState {
  readonly agentReady: boolean;
  readonly hasProject: boolean;
  readonly hasSession: boolean;
  readonly hasRoutine: boolean;
  readonly hasOtherMachine: boolean;
}

/** A warning is advisory, such as a quota note or sign-in that could not be checked. */
export function providerCanRunWork(
  provider: Pick<ServerProvider, "enabled" | "installed" | "status" | "availability" | "auth">,
): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated" &&
    (provider.status === "ready" || provider.status === "warning")
  );
}

export function whatYouCanDoItems(state: WhatYouCanDoState): WhatYouCanDoItem[] {
  return [
    {
      id: "agent",
      title: "Connect an agent",
      detail: "Sign in to Claude, Codex or another provider.",
      done: state.agentReady,
      action: { kind: "link", to: "/settings/providers", label: "Open Providers" },
    },
    {
      id: "project",
      title: "Add a project",
      detail: "Point SpecWithCode at a folder or repository.",
      done: state.hasProject,
      action: { kind: "link", to: "/settings/projects", label: "Open Projects" },
    },
    {
      id: "session",
      title: "Start a session",
      detail: "Describe a task and an agent works on it.",
      done: state.hasSession,
      action: { kind: "new-session", label: "New session" },
    },
    {
      id: "routine",
      title: "Set up a routine",
      detail: "Run a task on a schedule, without asking each time.",
      done: state.hasRoutine,
      action: { kind: "link", to: "/settings/scheduled-tasks", label: "Open Routines" },
    },
    {
      id: "machine",
      title: "Add another machine",
      detail: "See it from here, then let agents work on it.",
      done: state.hasOtherMachine,
      action: { kind: "link", to: "/settings/machines", label: "Open Machines" },
    },
  ];
}

/** Hidden once dismissed or finished, and until the workspace is known, so nothing ticks late. */
export function showWhatYouCanDo(input: {
  readonly dismissed: boolean;
  readonly known: boolean;
  readonly items: readonly WhatYouCanDoItem[];
}): boolean {
  return !input.dismissed && input.known && input.items.some((item) => !item.done);
}
