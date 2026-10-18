/**
 * The chips under an empty coordinator composer, like Claude's project home:
 * the same three ways in for every project, whatever the host found in it.
 * They open the empty conversation under a short greeting.
 * A prompt chip only fills the composer, so the person can edit it before it
 * goes to the coordinator; "Connect tools" opens the project's connections.
 */
import { BlocksIcon, ListChecksIcon, ZapIcon, type LucideIcon } from "lucide-react";

export type CoordinatorQuickStart =
  | { id: string; label: string; icon: LucideIcon; kind: "prompt"; prompt: string }
  | { id: string; label: string; icon: LucideIcon; kind: "connections" };

export const COORDINATOR_QUICK_STARTS: readonly CoordinatorQuickStart[] = [
  {
    id: "recent-work",
    label: "Set up from recent work",
    icon: ZapIcon,
    kind: "prompt",
    prompt:
      "Set up this project from my recent work. Start with the sessions on this machine (Claude Code, Codex and SpecWithCode threads for this folder), then recent commits, open branches and pull requests; if my private machines hold this project, check their threads too. Save the project's goal, instructions and memory, then tell me what is in flight and which threads to start first.",
  },
  { id: "connect-tools", label: "Connect tools", icon: BlocksIcon, kind: "connections" },
  {
    id: "make-plan",
    label: "Make a plan",
    icon: ListChecksIcon,
    kind: "prompt",
    prompt: "Make a plan for ",
  },
];

/**
 * "Hi Anton," from a host named the way macOS names a new Mac ("Anton's
 * MacBook Pro"); a plain "Hi there," otherwise. Callers pass a label only when
 * that host is the viewer's own Mac. Studio has no profile name of its own,
 * and an account email is not a name to greet anyone by.
 */
export function greetingLine(ownHostLabel: string | null): string {
  const owner = ownHostLabel?.match(
    /^\s*(\p{Lu}[\p{L}\p{M}-]{0,39})['’]s\s+(?:MacBook|iMac|Mac)\b/u,
  )?.[1];
  return owner ? `Hi ${owner},` : "Hi there,";
}

/**
 * The composer text after choosing a prompt chip. An empty composer, or one that
 * still holds another chip's untouched text, takes the chip's prompt; a draft the
 * person wrote is kept and the prompt goes on a new line after it.
 */
export function quickStartDraft(current: string, prompt: string): string {
  const draft = current.trim();
  if (
    draft === "" ||
    COORDINATOR_QUICK_STARTS.some((q) => q.kind === "prompt" && q.prompt.trim() === draft)
  )
    return prompt;
  return `${current.trimEnd()}\n${prompt}`;
}

export function CoordinatorQuickStarts(props: {
  disabled: boolean;
  onPrompt: (prompt: string) => void;
  onConnections: () => void;
}) {
  return (
    <ul className="sws-quick-starts" aria-label="Ways to begin">
      {COORDINATOR_QUICK_STARTS.map((quickStart) => {
        const Icon = quickStart.icon;
        return (
          <li key={quickStart.id}>
            <button
              type="button"
              className="sws-quick-start"
              data-quick-start={quickStart.id}
              disabled={props.disabled && quickStart.kind === "prompt"}
              onClick={() =>
                quickStart.kind === "prompt"
                  ? props.onPrompt(quickStart.prompt)
                  : props.onConnections()
              }
            >
              <Icon aria-hidden />
              {quickStart.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
