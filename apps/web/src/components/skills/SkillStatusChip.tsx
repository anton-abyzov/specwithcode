import { useTx } from "../../i18n";
import { Badge } from "../ui/badge";

/**
 * The per-machine status chips, shared wording with Integrations: where a
 * skill is, and why a machine could not say.
 */
export type SkillStatus =
  | { readonly kind: "on-this-machine" }
  | { readonly kind: "installed"; readonly version: string | null }
  | { readonly kind: "not-on"; readonly machine: string }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "offline" }
  | { readonly kind: "update-available"; readonly version: string }
  | { readonly kind: "not-checked" }
  | { readonly kind: "built-in" };

export function SkillStatusChip({ status }: { status: SkillStatus }) {
  const tx = useTx();
  switch (status.kind) {
    case "on-this-machine":
      return (
        <Badge variant="success" data-status={status.kind}>
          {tx("On this machine")}
        </Badge>
      );
    case "installed":
      return (
        <Badge variant="outline" data-status={status.kind}>
          {status.version ? `v${status.version}` : tx("Installed")}
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
    case "not-checked":
      return (
        <Badge variant="outline" className="text-muted-foreground" data-status={status.kind}>
          {tx("Not checked")}
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
