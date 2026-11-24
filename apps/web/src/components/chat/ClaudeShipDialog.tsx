import { CheckIcon, CopyIcon, TerminalSquareIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  CLAUDE_SHIP_MIN_VERSION,
  type ClaudeShipLine,
  type ClaudeShipNote,
  type ClaudeShipPlan,
} from "./claudeShip.logic";

export interface ClaudeShipDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly line: ClaudeShipLine;
  readonly plan: ClaudeShipPlan;
  /** Set while the terminal is being opened. */
  readonly opening: boolean;
  readonly error: string | null;
  readonly onOpenTerminal: () => void;
  /** Sends the line to Claude as a message, for a custom command of the same name. */
  readonly onSendAnyway: () => void;
}

function NoteText({ note }: { note: ClaudeShipNote }) {
  const tx = useTx();
  switch (note.kind) {
    case "outdated":
      return (
        <>
          {tx(
            "Claude Code {version} is installed on this machine. /ship and /steward need {minimum} or later. Run claude update in a terminal, then try again.",
            { version: note.version, minimum: CLAUDE_SHIP_MIN_VERSION },
          )}
        </>
      );
    case "plan":
      return (
        <>
          {tx(
            "This thread is in plan mode. The terminal session opens outside plan mode, because /ship commits and pushes.",
          )}
        </>
      );
    case "full-access":
      return (
        <>
          {tx(
            "This thread has full access. The terminal session opens in auto mode, because Claude Code starts no watch under bypass permissions.",
          )}
        </>
      );
    case "windows":
      return (
        <>
          {tx(
            "On Windows, Claude Code starts no watch. To get a review, run claude in a terminal yourself and type the line there.",
          )}
        </>
      );
    case "new-session":
      return (
        <>
          {tx(
            "This thread has no Claude session yet, so the terminal starts a new one. /ship writes the commit message from that session's conversation.",
          )}
        </>
      );
  }
}

/**
 * Claude Ship's commands start only from a line typed into an interactive
 * Claude Code session. The card opens one in the thread's terminal; the
 * person types the line there.
 */
export function ClaudeShipDialog(props: ClaudeShipDialogProps) {
  const tx = useTx();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const blocking = props.plan.notes.filter(
    (note) => note.kind === "outdated" || note.kind === "windows",
  );
  const advisory = props.plan.notes.filter(
    (note) => note.kind !== "outdated" && note.kind !== "windows",
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg" data-testid="claude-ship-dialog">
        <DialogHeader>
          <DialogTitle>
            {props.line.command === "ship"
              ? tx("Ship with Claude Code")
              : tx("Watch with Claude Code")}
          </DialogTitle>
          <DialogDescription>
            {props.line.command === "ship"
              ? tx(
                  "/ship commits your change, pushes it and opens a pull request as you, reviews it, then watches it and pushes fixes.",
                )
              : tx("/steward watches your open pull request and pushes fixes to it as you.")}{" "}
            {tx(
              "Claude Code runs it only from a line you type in its own terminal session, so it can't run as a message in this thread.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-muted-foreground">
                {tx("Open the terminal, then type this line at the Claude Code prompt:")}
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-sm"
                  data-testid="claude-ship-line"
                >
                  {props.line.line}
                </code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={isCopied ? tx("Copied") : tx("Copy line")}
                  onClick={() => copyToClipboard(props.line.line, undefined)}
                >
                  {isCopied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              </div>
            </div>
            {[...blocking, ...advisory].length > 0 && (
              <ul className="flex flex-col gap-1.5 text-sm" data-testid="claude-ship-notes">
                {blocking.map((note) => (
                  <li key={note.kind} className="text-destructive-foreground" data-kind={note.kind}>
                    <NoteText note={note} />
                  </li>
                ))}
                {advisory.map((note) => (
                  <li key={note.kind} className="text-muted-foreground" data-kind={note.kind}>
                    <NoteText note={note} />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              {tx(
                "The watch runs while that terminal stays open, under your gh and git sign-ins. Merge the pull request yourself. If you have your own command with this name, send the line to Claude instead.",
              )}
            </p>
            {props.error !== null && (
              <p className="text-sm text-destructive-foreground" role="alert">
                {props.error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            className="sm:me-auto"
            disabled={props.opening}
            onClick={props.onSendAnyway}
            data-testid="claude-ship-send-anyway"
          >
            {tx("Send to Claude instead")}
          </Button>
          <Button
            variant="outline"
            disabled={props.opening}
            onClick={() => props.onOpenChange(false)}
          >
            {tx("Cancel")}
          </Button>
          <Button
            disabled={!props.plan.canOpen || props.opening}
            onClick={props.onOpenTerminal}
            data-testid="claude-ship-open-terminal"
          >
            <TerminalSquareIcon />
            {tx("Open terminal")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
