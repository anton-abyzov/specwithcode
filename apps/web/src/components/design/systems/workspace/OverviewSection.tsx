/**
 * Overview: what the system is (name, description), its modes, where it came
 * from (sources and lineage), how many designs use it, then its README.
 */
import type { DesignOwnerInput, DesignSystem, EnvironmentId } from "@specweave-studio/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";
import { Button } from "../../../ui/button";
import { Textarea } from "../../../ui/textarea";
import { sourcesLabel } from "../reviewModel";
import { OverviewReadme } from "./OverviewReadme";
import { newModeId, type SystemEditIntent } from "./systemEditIntents";
import { longDate, plural, usageLabel } from "./systemText";
import { WelcomeSheet } from "./WelcomeSheet";

export interface OverviewSectionProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly system: DesignSystem;
  readonly canEdit: boolean;
  readonly onEdit: (intent: SystemEditIntent) => Promise<boolean>;
  /** Designs of the owner that use the system; null while unknown. */
  readonly usage: number | null;
  /** Files or an import changed the system outside the edit queue. */
  readonly onChanged?: (() => void) | undefined;
}

/** A system with no tokens and no components yet opens on the welcome sheet. */
export const isEmptySystem = (system: Pick<DesignSystem, "tokens" | "components">) =>
  system.tokens.length === 0 && system.components.length === 0;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function OverviewSection(props: OverviewSectionProps) {
  const { system } = props;
  const files = system.sources.filter((source) => source.kind === "file");
  const lineage =
    system.derivedFromLabel !== undefined
      ? `Derived from ${system.derivedFromLabel}`
      : system.copiedFrom !== null
        ? `Copied from revision ${system.copiedFrom.revision} of ${system.copiedFrom.id} on ${longDate(system.copiedFrom.copiedAt)}`
        : null;
  return (
    <div className="flex flex-col gap-6 px-4 pb-5" data-testid="overview-section">
      {isEmptySystem(system) ? (
        <WelcomeSheet
          environmentId={props.environmentId}
          owner={props.owner}
          systemId={system.id}
          canEdit={props.canEdit}
          {...(props.onChanged === undefined ? {} : { onChanged: props.onChanged })}
        />
      ) : null}
      <Description {...props} />
      <dl className="flex flex-col divide-y divide-border/50 border-border/50 border-y">
        <Fact label="Modes">
          <Modes {...props} />
        </Fact>
        <Fact label="Contents">
          {plural(system.tokens.length, "token")} · {plural(system.components.length, "component")}
        </Fact>
        <Fact label="Sources">
          {system.sources.length === 0 ? (
            "Started from scratch"
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <span>{sourcesLabel(system.sources)}</span>
              {files.length > 0 ? (
                <ul className="flex min-w-0 flex-col gap-0.5">
                  {files.slice(0, 8).map((source) => (
                    <li
                      key={source.location}
                      className="truncate font-mono text-muted-foreground text-xs"
                      title={source.location}
                    >
                      {source.location}
                    </li>
                  ))}
                  {files.length > 8 ? (
                    <li className="text-muted-foreground text-xs">
                      and {plural(files.length - 8, "more file")}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          )}
        </Fact>
        {lineage !== null ? <Fact label="Lineage">{lineage}</Fact> : null}
        <Fact label="Designs">
          <span data-testid="system-usage">{usageLabel(props.usage)}</span>
        </Fact>
        <Fact label="Revision">
          {system.revision} · Updated {longDate(system.updatedAt)}
        </Fact>
      </dl>
      <OverviewReadme
        environmentId={props.environmentId}
        owner={props.owner}
        systemId={system.id}
        canEdit={props.canEdit}
      />
    </div>
  );
}

function Description({ system, canEdit, onEdit }: OverviewSectionProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = system.description ?? "";
  if (!canEdit)
    return text === "" ? null : (
      <p className="max-w-[46rem] text-base text-muted-foreground leading-relaxed">{text}</p>
    );
  if (draft === null)
    return (
      <button
        type="button"
        className="-mx-2 max-w-[46rem] rounded-md px-2 py-1 text-left text-base leading-relaxed outline-none transition-colors duration-[120ms] hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setDraft(text)}
      >
        {text === "" ? (
          <span className="text-muted-foreground">
            Add a description of what this system is for.
          </span>
        ) : (
          <span className="text-muted-foreground">{text}</span>
        )}
      </button>
    );
  const save = () => {
    void onEdit({ kind: "set-info", description: draft });
    setDraft(null);
  };
  return (
    <div className="flex max-w-[46rem] flex-col gap-2">
      <Textarea
        autoFocus
        aria-label="Description"
        value={draft}
        maxLength={4_000}
        placeholder="What this system is for, in a sentence or two."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button size="xs" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Modes({ system, canEdit, onEdit }: OverviewSectionProps) {
  const [adding, setAdding] = useState(false);
  // Removing a mode deletes its value on every token, so it asks first.
  const [removing, setRemoving] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  const valuesIn = (modeId: string) =>
    system.tokens.filter((token) => token.values[modeId] !== undefined).length;
  return (
    <>
      <ul className="flex flex-wrap items-center gap-1.5" aria-label="Modes">
        {system.modes.map((mode, index) => (
          <li key={mode.id}>
            <ModeChip
              name={mode.name}
              note={index === 0 ? "First mode; other modes start from its values" : null}
              canEdit={canEdit}
              canRemove={canEdit && system.modes.length > 1}
              onRename={(name) => void onEdit({ kind: "put-mode", id: mode.id, name })}
              onRemove={() => setRemoving({ id: mode.id, name: mode.name })}
            />
          </li>
        ))}
        {canEdit ? (
          <li>
            {adding ? (
              <InlineName
                label="New mode name"
                initial=""
                onDone={(name) => {
                  setAdding(false);
                  if (name === null || name === "") return;
                  void onEdit({
                    kind: "put-mode",
                    id: newModeId(
                      name,
                      system.modes.map((mode) => mode.id),
                    ),
                    name,
                  });
                }}
              />
            ) : system.modes.length < 8 ? (
              <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden />
                Add mode
              </Button>
            ) : null}
          </li>
        ) : null}
      </ul>
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup data-testid="mode-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the {removing?.name} mode?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing === null
                ? null
                : `Its values on ${plural(valuesIn(removing.id), "token")} are deleted with it. You can undo right after.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              data-testid="mode-remove-confirm"
              onClick={() => {
                if (removing !== null) void onEdit({ kind: "delete-mode", id: removing.id });
                setRemoving(null);
              }}
            >
              Remove mode
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ModeChip({
  name,
  note,
  canEdit,
  canRemove,
  onRename,
  onRemove,
}: {
  name: string;
  note: string | null;
  canEdit: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  if (renaming)
    return (
      <InlineName
        label={`Rename mode ${name}`}
        initial={name}
        onDone={(next) => {
          setRenaming(false);
          if (next !== null && next !== "" && next !== name) onRename(next);
        }}
      />
    );
  return (
    <span
      className="inline-flex h-7 items-center gap-0.5 rounded-md border border-border/70 pr-0.5 pl-2 text-sm"
      title={note ?? undefined}
      data-testid="mode-chip"
    >
      {canEdit ? (
        <button
          type="button"
          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Rename mode ${name}`}
          onClick={() => setRenaming(true)}
        >
          {name}
        </button>
      ) : (
        <span className="pr-1.5">{name}</span>
      )}
      {canRemove ? (
        <Button
          variant="ghost-destructive"
          size="icon-micro"
          aria-label={`Remove mode ${name}`}
          title="Remove mode and its values"
          onClick={onRemove}
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </span>
  );
}

function InlineName({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  /** The trimmed name, or null when cancelled. */
  onDone: (name: string | null) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onDone(draft.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      onDone(null);
    }
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={draft}
      maxLength={180}
      className="h-7 w-32 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onDone(draft.trim())}
    />
  );
}
