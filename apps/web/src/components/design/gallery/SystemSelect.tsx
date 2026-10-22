import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
} from "@specweave-studio/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";

const NONE = "__none__";

/** Systems the owner holds; another owner's system must be copied first. */
export function systemsOwnedBy(
  systems: readonly DesignSystemSummary[],
  owner: DesignOwnerInput | null,
): DesignSystemSummary[] {
  if (owner === null) return [];
  return systems.filter((system) =>
    owner.kind === "playground"
      ? system.ref.owner.kind === "playground"
      : system.ref.owner.kind === "project" && system.ref.owner.projectId === owner.projectId,
  );
}

/**
 * "None" plus the owner's design systems. A stand-in until the design-system
 * picker lands; it offers exactly what `designSystem.list` returns.
 */
export function SystemSelect({
  id,
  systems,
  value,
  onChange,
}: {
  id: string;
  systems: readonly DesignSystemSummary[];
  value: DesignSystemId | null;
  onChange: (value: DesignSystemId | null) => void;
}) {
  const selected = systems.find((system) => system.ref.systemId === value) ?? null;
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) =>
        onChange(next === NONE || next === null ? null : (next as DesignSystemId))
      }
    >
      <SelectTrigger id={id} size="sm">
        <SelectValue>{selected?.name ?? "None"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={NONE}>None</SelectItem>
        {systems.map((system) => (
          <SelectItem key={system.ref.systemId} value={system.ref.systemId}>
            {system.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
