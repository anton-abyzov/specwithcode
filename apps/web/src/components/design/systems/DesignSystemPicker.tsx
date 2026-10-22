/**
 * Picks the design system a design uses. A design may only use a system its
 * owner holds, so another owner's system is offered as "Copy into …": the
 * copy is made first and then selected.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import {
  failureText,
  ownerName,
  ownerOfSummary,
  sameOwner,
  systemKey,
  type OwnerProject,
} from "./reviewModel";
import { useOwnerProjects } from "./useOwnerProjects";

const NONE = "__none__";
const COPY = "copy:";

export type CopyOutcome =
  | { readonly ok: true; readonly systemId: DesignSystemId; readonly name: string }
  | { readonly ok: false; readonly message: string };

export interface DesignSystemPickerViewProps {
  id?: string;
  owner: DesignOwnerInput;
  /** Every system this caller can read; null while loading. */
  systems: readonly DesignSystemSummary[] | null;
  projects: readonly OwnerProject[];
  value: DesignSystemId | null;
  onChange: (value: DesignSystemId | null) => void;
  /** Copies another owner's system into `owner`. Without it, other owners' systems are not offered. */
  onCopy?: ((system: DesignSystemSummary) => Promise<CopyOutcome>) | null;
  disabled?: boolean;
  /** In a fixed-height bar: loading shows in the trigger and a copy error floats below it. */
  inline?: boolean;
}

export function DesignSystemPickerView({
  id,
  owner,
  systems,
  projects,
  value,
  onChange,
  onCopy = null,
  disabled = false,
  inline = false,
}: DesignSystemPickerViewProps) {
  const [copying, setCopying] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: DesignSystemId; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const all = systems ?? [];
  const own = all.filter((system) => sameOwner(ownerOfSummary(system), owner));
  const others = onCopy === null ? [] : all.filter((system) => !own.includes(system));
  const target = ownerName(owner, projects);
  const selected =
    own.find((system) => system.ref.systemId === value)?.name ??
    (copied !== null && copied.id === value ? copied.name : null);

  const pick = (next: string | null) => {
    setError(null);
    if (next === null || next === NONE) return onChange(null);
    if (!next.startsWith(COPY)) return onChange(next as DesignSystemId);
    const source = others.find((system) => `${COPY}${systemKey(system)}` === next);
    if (source === undefined || onCopy === null) return;
    setCopying(source.name);
    void onCopy(source).then((outcome) => {
      setCopying(null);
      if (!outcome.ok) return setError(outcome.message);
      setCopied({ id: outcome.systemId, name: outcome.name });
      onChange(outcome.systemId);
    });
  };

  return (
    <div
      className={cn("flex flex-col gap-1.5", inline && "relative")}
      data-testid="design-system-picker"
    >
      <Select value={value ?? NONE} onValueChange={pick} disabled={disabled || copying !== null}>
        <SelectTrigger id={id} size="sm">
          <SelectValue>
            {copying !== null
              ? `Copying ${copying} into ${target}…`
              : inline && systems === null && value !== null
                ? "Loading…"
                : (selected ?? (value === null ? "None" : "Unknown system"))}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={NONE}>None</SelectItem>
          {own.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>{target}</SelectGroupLabel>
              {own.map((system) => (
                <SelectItem key={system.ref.systemId} value={system.ref.systemId}>
                  {system.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {others.length > 0 ? (
            <SelectGroup>
              <SelectGroupLabel>Other projects</SelectGroupLabel>
              {others.map((system) => (
                <SelectItem
                  key={systemKey(system)}
                  value={`${COPY}${systemKey(system)}`}
                  data-testid="design-system-picker-copy"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{system.name}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {system.ownerLabel} · Copy into {target}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectPopup>
      </Select>
      {systems === null && !inline ? (
        <p className="text-muted-foreground text-xs">Loading design systems…</p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className={cn(
            "text-destructive-foreground text-xs",
            inline &&
              "absolute top-full left-0 z-10 mt-1 w-max max-w-72 rounded-md border bg-popover px-2 py-1 shadow-sm",
          )}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Copies a system into another owner, then refreshes the caller's system list.
 * Shared by the connected picker and the gallery's new-design dialogs.
 */
export function useCopyDesignSystem(
  environmentId: EnvironmentId | null,
  refresh: () => void,
): (system: DesignSystemSummary, to: DesignOwnerInput) => Promise<CopyOutcome> {
  const copySystem = useAtomCommand(design.systemCopy, { reportFailure: false });
  return async (system, to) => {
    if (environmentId === null) return { ok: false, message: "Connect to this Mac first." };
    const result = await copySystem({
      environmentId,
      input: { owner: ownerOfSummary(system), systemId: system.ref.systemId, to },
    });
    if (result._tag === "Failure")
      return {
        ok: false,
        message: failureText(squashAtomCommandFailure(result), "The design system was not copied."),
      };
    refresh();
    return { ok: true, systemId: result.value.ref.systemId, name: result.value.system.name };
  };
}

/** The picker wired to this machine's design systems. */
export function DesignSystemPicker({
  id,
  owner,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  owner: DesignOwnerInput;
  value: DesignSystemId | null;
  onChange: (value: DesignSystemId | null) => void;
  disabled?: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useOwnerProjects(environmentId);
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : design.systemList({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const copy = useCopyDesignSystem(environmentId, list.refresh);
  const onCopy = (system: DesignSystemSummary) => copy(system, owner);

  return (
    <DesignSystemPickerView
      {...(id !== undefined ? { id } : {})}
      owner={owner}
      systems={list.data?.systems ?? (list.error ? [] : null)}
      projects={projects}
      value={value}
      onChange={onChange}
      onCopy={onCopy}
      {...(disabled !== undefined ? { disabled } : {})}
    />
  );
}
