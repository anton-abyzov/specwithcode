/**
 * "From this project's code": scan a project for token files and component
 * barrels, then propose one suggested system from the files the user keeps.
 */
import type {
  DesignSystemCandidate,
  DesignSystemProposeInput,
  DesignSystemScanResult,
  DesignSystemSuggestion,
  ProjectId,
} from "@specweave-studio/contracts";
import { FileCodeIcon, ScanSearchIcon } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  CANDIDATE_KIND_LABELS,
  formatBytes,
  lineageText,
  offeredProjects,
  SKIP_REASON_LABELS,
  type OwnerProject,
} from "./reviewModel";

export type ScanOutcome =
  | { readonly ok: true; readonly result: DesignSystemScanResult }
  | { readonly ok: false; readonly message: string };

const OTHER = "__other__";

/** Suggestions with their candidates; files no suggestion claims go under "Other files". */
export function groupCandidates(result: DesignSystemScanResult, fallbackName: string) {
  const known = new Set(result.suggestions.map((suggestion) => suggestion.key));
  const groups: Array<{ suggestion: DesignSystemSuggestion; candidates: DesignSystemCandidate[] }> =
    result.suggestions.map((suggestion) => ({
      suggestion,
      candidates: result.candidates.filter((candidate) => candidate.suggestion === suggestion.key),
    }));
  const rest = result.candidates.filter((candidate) => !known.has(candidate.suggestion));
  if (rest.length > 0)
    groups.push({
      suggestion: { key: OTHER, name: fallbackName, paths: [], copies: [] },
      candidates: rest,
    });
  return groups;
}

function initialSelection(result: DesignSystemScanResult): Record<string, string[]> {
  return Object.fromEntries(
    result.suggestions.map((suggestion) => [suggestion.key, [...suggestion.paths]]),
  );
}

function CandidateRow({
  candidate,
  checked,
  onChange,
}: {
  candidate: DesignSystemCandidate;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const counts = [
    candidate.tokenCount > 0 ? `${candidate.tokenCount} tokens` : null,
    candidate.componentCount > 0 ? `${candidate.componentCount} components` : null,
  ].filter(Boolean);
  return (
    <li
      data-testid="scan-candidate"
      data-path={candidate.path}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-3 py-2"
    >
      <Checkbox
        className="mt-0.5"
        aria-label={`Use ${candidate.path}`}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <code className="break-all font-mono text-xs text-foreground">{candidate.path}</code>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          <Badge variant="outline" size="sm">
            {CANDIDATE_KIND_LABELS[candidate.kind]}
          </Badge>
          <span>{counts.length > 0 ? counts.join(" · ") : "Nothing found yet"}</span>
          {candidate.modes.length > 0 ? <span>Modes: {candidate.modes.join(", ")}</span> : null}
          <span>{formatBytes(candidate.bytes)}</span>
        </span>
      </div>
    </li>
  );
}

export function ScanFromCode({
  projects: allProjects,
  onScan,
  onPropose,
}: {
  projects: readonly OwnerProject[];
  onScan: (projectId: ProjectId) => Promise<ScanOutcome>;
  /** Resolves to an error message, or null once the review is open. */
  onPropose: (input: DesignSystemProposeInput) => Promise<string | null>;
}) {
  const id = useId();
  // Only the person's own code projects have code to scan.
  const projects = offeredProjects(allProjects, "code");
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const [result, setResult] = useState<DesignSystemScanResult | null>(null);
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;

  if (projects.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Add a code project first. The Playground has no code to scan, so this needs a project.
      </p>
    );

  const scan = () => {
    if (projectId === null) return;
    setBusy("scan");
    setError(null);
    void onScan(projectId).then((outcome) => {
      setBusy(null);
      if (!outcome.ok) return setError(outcome.message);
      setResult(outcome.result);
      setSelection(initialSelection(outcome.result));
    });
  };

  const propose = (suggestion: DesignSystemSuggestion, paths: readonly string[]) => {
    if (projectId === null || paths.length === 0) return;
    setBusy(suggestion.key);
    setError(null);
    void onPropose({
      owner: { kind: "project", projectId },
      from: { kind: "code", paths: [...paths], name: suggestion.name },
    }).then((problem) => {
      setBusy(null);
      setError(problem);
    });
  };

  const groups =
    result === null ? [] : groupCandidates(result, `${project?.title ?? "Project"} design system`);

  return (
    <div className="flex flex-col gap-4" data-testid="scan-from-code">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-project`}>Project</Label>
          <Select
            value={projectId ?? ""}
            onValueChange={(value) => {
              setProjectId((value as ProjectId | null) ?? null);
              setResult(null);
            }}
          >
            <SelectTrigger id={`${id}-project`} size="sm">
              <SelectValue>{project?.title ?? "Choose a project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button size="sm" disabled={busy !== null || projectId === null} onClick={scan}>
          <ScanSearchIcon aria-hidden />
          {busy === "scan" ? "Scanning…" : result === null ? "Scan project" : "Scan again"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Looks for token files (Weave, DTCG, Tokens Studio), CSS variables, TypeScript themes and
        component barrels. Nothing is saved until you confirm the review.
      </p>

      {result !== null ? (
        <div className="flex flex-col gap-3" data-testid="scan-result">
          <p className="text-xs text-muted-foreground">
            Looked at {result.filesSeen.toLocaleString()} files and found {result.candidates.length}{" "}
            {result.candidates.length === 1 ? "candidate" : "candidates"}.
            {result.truncated
              ? " The scan stopped at its file limit; some folders were not read."
              : ""}
          </p>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No token files or component barrels were found in {project?.title}.
            </p>
          ) : null}
          {groups.map(({ suggestion, candidates }) => {
            const ticked = selection[suggestion.key] ?? [];
            return (
              <section
                key={suggestion.key}
                data-testid="scan-suggestion"
                data-key={suggestion.key}
                className="overflow-hidden rounded-lg border border-border/60 bg-card/40"
              >
                <header className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2">
                  <FileCodeIcon aria-hidden className="size-4 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <h4 className="truncate text-sm font-medium text-foreground">
                      {suggestion.key === OTHER ? "Other files" : suggestion.name}
                    </h4>
                    {suggestion.description || suggestion.derivedFromLabel ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {suggestion.description}
                        {suggestion.derivedFromLabel ? ` ${lineageText(suggestion)}` : ""}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="xs"
                    data-testid="scan-propose"
                    disabled={busy !== null || ticked.length === 0}
                    onClick={() => propose(suggestion, ticked)}
                  >
                    {busy === suggestion.key
                      ? "Reading files…"
                      : `Propose ${suggestion.key === OTHER ? "these files" : suggestion.name}`}
                  </Button>
                </header>
                <ul className="divide-y divide-border/40">
                  {candidates.map((candidate) => (
                    <CandidateRow
                      key={candidate.path}
                      candidate={candidate}
                      checked={ticked.includes(candidate.path)}
                      onChange={(checked) =>
                        setSelection((current) => {
                          const paths = (current[suggestion.key] ?? []).filter(
                            (path) => path !== candidate.path,
                          );
                          return {
                            ...current,
                            [suggestion.key]: checked ? [...paths, candidate.path] : paths,
                          };
                        })
                      }
                    />
                  ))}
                </ul>
                {suggestion.copies.length > 0 ? (
                  <p className="border-t border-border/40 px-3 py-2 text-2xs text-muted-foreground">
                    Copies compared, not imported:{" "}
                    <code className="font-mono">{suggestion.copies.join(", ")}</code>
                  </p>
                ) : null}
              </section>
            );
          })}
          {result.skipped.length > 0 ? (
            <section className="flex flex-col gap-1" data-testid="scan-skipped">
              <h4 className="text-xs font-medium text-muted-foreground">Skipped files</h4>
              <ul className="flex flex-col gap-0.5 text-xs">
                {result.skipped.map((skip) => (
                  <li key={skip.path} className="flex min-w-0 gap-2">
                    <code className="truncate font-mono text-muted-foreground">{skip.path}</code>
                    <span className="shrink-0 text-foreground/80">
                      {SKIP_REASON_LABELS[skip.reason]}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
