/**
 * Review of a design-system proposal: what would be added, changed or
 * removed, the findings, and a tick per item. Only Confirm writes anything.
 */
import type {
  DesignSystemConfirmInput,
  DesignSystemProposal,
  DesignSystemFinding,
} from "@specweave-studio/contracts";
import { ChevronDownIcon, ChevronRightIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { ComponentRow, FileRow, TokenRow } from "./ReviewRows";
import {
  buildConfirmInput,
  CHANGE_GROUPS,
  EMPTY_SELECTION,
  groupByChange,
  locationLabel,
  proposalCounts,
  proposalMeta,
  toggleItems,
  writeCount,
  type ReviewSelection,
} from "./reviewModel";

export interface DesignSystemReviewProps {
  proposal: DesignSystemProposal;
  /** Project title or "Playground". */
  ownerLabel: string;
  /** Title of the thread an agent proposed from, when known. */
  threadTitle?: string | null;
  busy?: boolean;
  /** A failed confirm or discard, conflicts included, in plain words. */
  error?: string | null;
  onConfirm: (input: DesignSystemConfirmInput) => void;
  onDiscard: () => void;
  className?: string;
}

function Findings({ findings }: { findings: readonly DesignSystemFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <section aria-label="Findings" className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">Findings</h4>
      <ul className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60 bg-card/40">
        {findings.map((finding) => (
          <li
            key={`${finding.code}:${finding.location ?? ""}:${finding.line ?? ""}:${finding.message}`}
            data-testid="review-finding"
            data-severity={finding.severity}
            className="flex items-start gap-2 px-3 py-2 text-xs"
          >
            {finding.severity === "warning" ? (
              <TriangleAlertIcon
                aria-label="Warning"
                className="mt-0.5 size-3.5 shrink-0 text-warning-foreground"
              />
            ) : (
              <InfoIcon
                aria-label="Note"
                className="mt-0.5 size-3.5 shrink-0 text-info-foreground"
              />
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-foreground">{finding.message}</span>
              {finding.location ? (
                <code className="truncate font-mono text-2xs text-muted-foreground">
                  {locationLabel({
                    location: finding.location,
                    ...(finding.line !== undefined ? { line: finding.line } : {}),
                  })}
                </code>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangeGroup({
  title,
  hint,
  keys,
  unticked,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  keys: readonly string[];
  unticked: ReadonlySet<string>;
  onToggle: (keys: readonly string[], ticked: boolean) => void;
  children: ReactNode;
}) {
  if (keys.length === 0) return null;
  const tickedCount = keys.filter((key) => !unticked.has(key)).length;
  const all = tickedCount === keys.length;
  return (
    <section
      data-testid="review-group"
      data-group={title}
      className="overflow-hidden rounded-lg border border-border/60 bg-card/40"
    >
      <header className="flex items-center gap-3 border-b border-border/50 bg-muted/30 px-3 py-1.5">
        <Checkbox
          aria-label={`Include all ${title.toLowerCase()}`}
          checked={all}
          indeterminate={!all && tickedCount > 0}
          onCheckedChange={() => onToggle(keys, !all)}
        />
        <h4 className="text-xs font-medium text-foreground">
          {title} <span className="text-muted-foreground">({keys.length})</span>
        </h4>
        <span className="ml-auto truncate text-2xs text-muted-foreground">{hint}</span>
      </header>
      <ul className="divide-y divide-border/40">{children}</ul>
    </section>
  );
}

function Unchanged({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <Button
        variant="ghost-muted"
        size="xs"
        className="self-start"
        aria-expanded={open}
        data-testid="review-unchanged-toggle"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        {count} unchanged
      </Button>
      {open ? (
        <ul
          data-testid="review-unchanged"
          className="divide-y divide-border/40 rounded-lg border border-border/60 opacity-80"
        >
          {children}
        </ul>
      ) : null}
    </section>
  );
}

export function DesignSystemReview({
  proposal,
  ownerLabel,
  threadTitle = null,
  busy = false,
  error = null,
  onConfirm,
  onDiscard,
  className,
}: DesignSystemReviewProps) {
  const id = useId();
  const [selection, setSelection] = useState<ReviewSelection>(EMPTY_SELECTION);
  const [name, setName] = useState(proposal.system.name);
  const [tab, setTab] = useState<"tokens" | "components" | "files">(
    proposal.tokens.length === 0 && proposal.components.length > 0 ? "components" : "tokens",
  );
  const files = proposal.files ?? [];
  const counts = proposalCounts(proposal);
  const tokens = groupByChange(proposal.tokens);
  const components = groupByChange(proposal.components);
  const toWrite = writeCount(proposal, selection);
  const isNew = proposal.target === null;
  const modes = proposal.system.modes;

  const toggle = (kind: keyof ReviewSelection) => (keys: readonly string[], ticked: boolean) =>
    setSelection((current) => toggleItems(current, kind, keys, ticked));

  return (
    <div
      data-testid="design-system-review"
      className={cn("flex min-h-0 flex-col bg-background", className)}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <header className="flex flex-col gap-2">
          {isNew ? (
            <div className="flex max-w-sm flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                size="sm"
                value={name}
                maxLength={180}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : (
            <h3 className="text-base font-medium text-foreground">
              {proposal.system.name}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                update to revision {proposal.target!.revision + 1}
              </span>
            </h3>
          )}
          <p className="text-xs text-muted-foreground" data-testid="review-meta">
            {proposalMeta(proposal.origin, ownerLabel, proposal.createdBy, threadTitle)}
          </p>
          <div className="flex flex-wrap gap-1.5" data-testid="review-counts">
            {counts.added > 0 || (counts.changed === 0 && counts.removed === 0) ? (
              <Badge variant="success">{counts.added} new</Badge>
            ) : null}
            {counts.changed > 0 ? <Badge variant="info">{counts.changed} changed</Badge> : null}
            {counts.removed > 0 ? <Badge variant="error">{counts.removed} removed</Badge> : null}
            {counts.findings > 0 ? (
              <Badge variant="warning">
                {counts.findings} {counts.findings === 1 ? "finding" : "findings"}
              </Badge>
            ) : null}
            <Badge variant="outline">
              {modes.length} {modes.length === 1 ? "mode" : "modes"}:{" "}
              {modes.map((mode) => mode.name).join(", ")}
            </Badge>
          </div>
        </header>

        <Findings findings={proposal.findings} />

        <ToggleGroup
          aria-label="Show"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "tokens" || value === "components" || value === "files") setTab(value);
          }}
        >
          <Toggle value="tokens" size="sm">
            Tokens ({proposal.tokens.length})
          </Toggle>
          <Toggle value="components" size="sm">
            Components ({proposal.components.length})
          </Toggle>
          {files.length > 0 ? (
            <Toggle value="files" size="sm">
              Files ({files.length})
            </Toggle>
          ) : null}
        </ToggleGroup>

        {tab === "files" ? (
          <div className="flex flex-col gap-3" data-testid="review-files">
            <ChangeGroup
              title="Brand files"
              hint="README to Overview, images to Assets, fonts to Typography"
              keys={files.map((file) => file.path)}
              unticked={selection.files}
              onToggle={toggle("files")}
            >
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  checked={!selection.files.has(file.path)}
                  onChange={(ticked) => toggle("files")([file.path], ticked)}
                />
              ))}
            </ChangeGroup>
          </div>
        ) : tab === "tokens" ? (
          <div className="flex flex-col gap-3" data-testid="review-tokens">
            {CHANGE_GROUPS.map((group) => (
              <ChangeGroup
                key={group.change}
                title={group.title}
                hint={group.hint}
                keys={tokens[group.change].map((change) => change.name)}
                unticked={selection.tokens}
                onToggle={toggle("tokens")}
              >
                {tokens[group.change].map((change) => (
                  <TokenRow
                    key={change.name}
                    change={change}
                    modes={modes}
                    checked={!selection.tokens.has(change.name)}
                    onChange={(ticked) => toggle("tokens")([change.name], ticked)}
                  />
                ))}
              </ChangeGroup>
            ))}
            <Unchanged count={tokens.unchanged.length}>
              {tokens.unchanged.map((change) => (
                <TokenRow
                  key={change.name}
                  change={change}
                  modes={modes}
                  checked={null}
                  onChange={null}
                />
              ))}
            </Unchanged>
            {proposal.tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tokens were found.</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="review-components">
            {CHANGE_GROUPS.map((group) => (
              <ChangeGroup
                key={group.change}
                title={group.title}
                hint={group.hint}
                keys={components[group.change].map((change) => change.id)}
                unticked={selection.components}
                onToggle={toggle("components")}
              >
                {components[group.change].map((change) => (
                  <ComponentRow
                    key={change.id}
                    change={change}
                    checked={!selection.components.has(change.id)}
                    onChange={(ticked) => toggle("components")([change.id], ticked)}
                  />
                ))}
              </ChangeGroup>
            ))}
            <Unchanged count={components.unchanged.length}>
              {components.unchanged.map((change) => (
                <ComponentRow key={change.id} change={change} checked={null} onChange={null} />
              ))}
            </Unchanged>
            {proposal.components.length === 0 ? (
              <p className="text-xs text-muted-foreground">No components were found.</p>
            ) : null}
          </div>
        )}
      </div>

      <footer className="flex flex-col gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
        {error ? (
          <p
            role="alert"
            data-testid="review-error"
            className="text-sm text-destructive-foreground"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="review-summary">
            {toWrite === 0
              ? "Nothing ticked changes the system."
              : `${toWrite} ${toWrite === 1 ? "change" : "changes"} will be written to ${ownerLabel}.`}
          </span>
          <span className="flex-1" />
          <Button variant="destructive-outline" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            data-testid="review-confirm"
            disabled={busy || toWrite === 0 || (isNew && name.trim() === "")}
            onClick={() => onConfirm(buildConfirmInput(proposal, selection, name))}
          >
            {busy ? "Saving…" : isNew ? "Create design system" : "Confirm changes"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
