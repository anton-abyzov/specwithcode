import type { ProjectSkillCopy, ProjectSkillCopiesResult } from "@specweave-studio/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

export function skillCopyDiff(before: string, after: string) {
  const a = before.split(/\r?\n/),
    b = after.split(/\r?\n/);
  let start = 0,
    end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (
    end < Math.min(a.length, b.length) - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    ...a.slice(0, start).map((text) => ({ kind: "same" as const, text })),
    ...a.slice(start, a.length - end).map((text) => ({ kind: "removed" as const, text })),
    ...b.slice(start, b.length - end).map((text) => ({ kind: "added" as const, text })),
    ...a.slice(a.length - end).map((text) => ({ kind: "same" as const, text })),
  ];
}

export function SkillCopyCompare({
  copies,
  machineLabel,
  busy,
  canWrite,
  preview,
  onPreview,
  onApply,
  onCancel,
}: {
  copies: ReadonlyArray<ProjectSkillCopy>;
  machineLabel: string;
  busy: boolean;
  canWrite: boolean;
  preview: ProjectSkillCopiesResult | null;
  onPreview: (sourceId: string, targetIds: string[]) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [sourceId, setSourceId] = useState(copies[0]?.id ?? "");
  const [compareId, setCompareId] = useState(copies[1]?.id ?? "");
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const source = copies.find((c) => c.id === sourceId) ?? copies[0];
  const comparison =
    copies.find((c) => c.id === compareId && c.id !== source?.id) ??
    copies.find((c) => c.id !== source?.id);
  if (!source) return <p className="text-muted-foreground">No readable copies were found.</p>;
  if (copies.length < 2)
    return (
      <p className="text-muted-foreground">
        Only one copy was found on {machineLabel}. There is nothing to compare.
      </p>
    );
  const lines = comparison ? skillCopyDiff(comparison.content, source.content) : [];
  const changeSelection = () => {
    setTargets(new Set());
    onCancel();
  };
  return (
    <section className="space-y-4" aria-label="Compare skill copies">
      <p className="text-sm text-muted-foreground">
        Compare copies on {machineLabel}. Choose the content to keep, then review exactly which
        copies will change.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Content to keep
          <select
            aria-label="Content to keep"
            value={source.id}
            disabled={busy}
            onChange={(e) => {
              setSourceId(e.target.value);
              changeSelection();
            }}
            className="block w-full min-w-0 rounded-md border bg-background p-2"
          >
            {copies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.agents.map((a) => a.label).join(", ")} · {c.version ?? "Unversioned"}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Compare with
          <select
            aria-label="Compare with"
            value={comparison?.id ?? ""}
            disabled={busy}
            onChange={(e) => setCompareId(e.target.value)}
            className="block w-full min-w-0 rounded-md border bg-background p-2"
          >
            {copies
              .filter((c) => c.id !== source.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.agents.map((a) => a.label).join(", ")} · {c.version ?? "Unversioned"}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[source, comparison].filter(Boolean).map((c) => (
          <div key={c!.id} className="min-w-0 space-y-1 text-xs text-muted-foreground">
            <p className="break-all">{c!.path}</p>
            <p>
              {machineLabel} · {c!.scope ?? "Unknown scope"} · {c!.version ?? "No version declared"}
            </p>
            <p className="break-all font-mono" title={c!.hash}>
              SHA-256 {c!.hash}
            </p>
            {c!.reason ? <p>{c!.reason}</p> : null}
          </div>
        ))}
      </div>
      {source.hash === comparison?.hash ? (
        <p className="text-sm">These copies have identical contents.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            − Removed from comparison copy · + Added from content to keep
          </p>
          <pre
            aria-label="Copy differences"
            className="max-h-80 overflow-auto rounded-md border bg-muted/25 p-2 text-xs leading-5"
          >
            {lines.slice(0, 1600).map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === "added"
                    ? "bg-success/10 text-success-foreground"
                    : line.kind === "removed"
                      ? "bg-destructive/10 text-destructive-foreground"
                      : "text-muted-foreground"
                }
              >
                <span className="select-none" aria-hidden>
                  {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
                </span>
                {line.text || " "}
              </div>
            ))}
          </pre>
          {lines.length > 1600 ? (
            <p className="text-xs text-muted-foreground">
              Showing the first 1,600 diff lines. Review the source files before applying a large
              change.
            </p>
          ) : null}
        </>
      )}
      {!canWrite ? (
        <p className="text-sm text-muted-foreground">
          File write access is required to replace copies.
        </p>
      ) : null}
      <fieldset disabled={busy || !canWrite} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Replace these copies</legend>
        {copies
          .filter((c) => c.id !== source.id)
          .map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={targets.has(c.id)}
                disabled={!c.writable || c.hash === source.hash}
                onCheckedChange={(checked) => {
                  setTargets((old) => {
                    const next = new Set(old);
                    if (checked) next.add(c.id);
                    else next.delete(c.id);
                    return next;
                  });
                  onCancel();
                }}
              />
              <span className="min-w-0">
                <span>{c.agents.map((a) => a.label).join(", ")}</span>
                <span className="block break-all text-xs text-muted-foreground">{c.path}</span>
                {!c.writable ? (
                  <span className="block text-xs text-muted-foreground">
                    {c.reason ?? "This copy is managed by its provider."}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
      </fieldset>
      {preview ? (
        <div className="space-y-3 rounded-md border p-3" role="status">
          <p className="text-sm">
            Replace {preview.targetIds?.length ?? 0} copies with the selected content. Their
            contents must still match this preview. This does not publish a version.
          </p>
          <p className="break-all text-xs">Content to keep: {source.path}</p>
          {preview.targetIds?.map((id) => {
            const target = preview.copies.find((c) => c.id === id);
            if (!target) return null;
            return (
              <details key={id} className="rounded border p-2">
                <summary className="cursor-pointer break-all text-xs">
                  {target.agents.map((a) => a.label).join(", ")} · {target.path}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto text-xs">
                  {skillCopyDiff(target.content, source.content).map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.kind === "added"
                          ? "text-success-foreground"
                          : line.kind === "removed"
                            ? "text-destructive-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
                      {line.text}
                    </div>
                  ))}
                </pre>
              </details>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !canWrite} onClick={onApply}>
              Confirm replacement
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          disabled={busy || !canWrite || targets.size === 0 || lines.length > 1600}
          onClick={() => onPreview(source.id, [...targets])}
        >
          Choose this copy
        </Button>
      )}
    </section>
  );
}
