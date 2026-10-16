import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { DraftId } from "../../composerDraftStore";
import type { ChatLayoutMode } from "./embeddedProjectLayout";

export type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      layoutMode?: ChatLayoutMode;
      /** Project review dialog: native decisions, without another conversation or composer. */
      reviewOnly?: boolean;
      /** A subagent's peek: its conversation, read-only, with no composer or parent divider. */
      transcriptOnly?: boolean;
      /** Keep a background worker mounted without handling shortcuts behind an overlay. */
      suspendShortcuts?: boolean;
      /** Embedded only: the host's header slot for the terminal and details toggles. */
      embeddedHeaderToolsTarget?: HTMLElement | null;
      forceExpandedMobileComposer?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      layoutMode?: ChatLayoutMode;
      reviewOnly?: boolean;
      transcriptOnly?: boolean;
      /** Keep a background worker mounted without handling shortcuts behind an overlay. */
      suspendShortcuts?: boolean;
      embeddedHeaderToolsTarget?: HTMLElement | null;
      forceExpandedMobileComposer?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

export type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;
