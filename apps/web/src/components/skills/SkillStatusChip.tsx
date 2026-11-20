import { useTx } from "../../i18n";
import { Badge } from "../ui/badge";

/**
 * The per-machine status chips. "Offline" is the word Integrations uses too;
 * the rest are the Skills page's own. `not-read` says why a machine gave no
 * answer, so it is never mistaken for a machine without the skill.
 */
export type SkillStatus =
  | { readonly kind: "installed"; readonly version: string | null }
  | { readonly kind: "not-on"; readonly machine: string }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "offline" }
  | { readonly kind: "update-available"; readonly version: string }
  | {
      readonly kind: "not-read";
      readonly reason: "checking" | "unlinked" | "failed" | "incomplete" | "machine-list";
    }
  | { readonly kind: "built-in" };

export function SkillStatusChip({ status }: { status: SkillStatus }) {
  const tx = useTx();
  switch (status.kind) {
    case "installed":
      return (
        <Badge variant="success" data-status={status.kind}>
          {status.version ? `v${status.version.replace(/^v/i, "")}` : tx("Installed")}
        </Badge>
      );
    case "not-on":
      return (
        <Badge variant="outline" className="text-muted-foreground" data-status={status.kind}>
          {tx("Not on {machine}", { machine: status.machine })}
        </Badge>
      );
    case "needs-sign-in":
      return (
        <Badge variant="warning" data-status={status.kind}>
          {tx("Needs sign-in")}
        </Badge>
      );
    case "offline":
      return (
        <Badge variant="secondary" data-status={status.kind}>
          {tx("Offline")}
        </Badge>
      );
    case "update-available":
      return (
        <Badge variant="info" data-status={status.kind}>
          {tx("Update available {version}", { version: status.version })}
        </Badge>
      );
    case "not-read":
      return (
        <Badge
          variant="outline"
          className="text-muted-foreground"
          data-status={status.kind}
          data-reason={status.reason}
        >
          {status.reason === "checking"
            ? tx("Reading…")
            : status.reason === "unlinked"
              ? tx("No project there")
              : status.reason === "incomplete"
                ? tx("Scan incomplete")
                : status.reason === "machine-list"
                  ? tx("Not checked per folder")
                  : tx("Could not be read")}
        </Badge>
      );
    case "built-in":
      return (
        <Badge variant="secondary" data-status={status.kind}>
          {tx("Built into the agent")}
        </Badge>
      );
  }
}
