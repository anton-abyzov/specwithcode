/** Older destinations do not advertise their resolved machine default. */
export function destinationDefaultWorktreeStorage(
  environment: object | null | undefined,
): string | null {
  if (!environment || !("defaultWorktreesDirectory" in environment)) return null;
  const value = environment.defaultWorktreesDirectory;
  return typeof value === "string" && value.trim() ? value : null;
}

/** Paths are facts from the selected project, thread and destination preview, never guesses. */
export interface HandoffWorkspaceContext {
  readonly projectFolder: string;
  readonly repository?: string | null | undefined;
  readonly checkout?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly mode?: "local" | "worktree" | null | undefined;
}

export function HandoffWorkspaceSummary({
  source,
  copyRoot,
  destinationFolder,
  destinationCheckout,
  destinationWorktreeStorage,
  transferContext = true,
}: {
  readonly source: HandoffWorkspaceContext;
  readonly transferContext?: boolean;
  readonly copyRoot?: string | null | undefined;
  readonly destinationFolder?: string | null | undefined;
  readonly destinationCheckout?: string | null | undefined;
  /** Only supply a path resolved by the destination, never a local settings fallback. */
  readonly destinationWorktreeStorage?: string | null | undefined;
}) {
  const rows = [
    ["Source project folder", source.projectFolder],
    ["Selected repository", source.repository ?? "Not reported"],
    ["Current checkout", source.checkout ?? "Not reported by the source thread"],
    [
      "Current mode",
      source.mode === "worktree"
        ? "Worktree"
        : source.mode === "local"
          ? "Local · current checkout"
          : "Not reported",
    ],
    ["Current branch", source.branch ?? "Not reported"],
    ...(copyRoot ? [["Copy root", copyRoot]] : []),
    ["Destination project folder", destinationFolder || "Choose a destination folder"],
    ["Destination checkout", destinationCheckout || "Verified when reviewing the handoff"],
    [
      "Destination worktree storage",
      destinationWorktreeStorage
        ? `${destinationWorktreeStorage} (machine default; project overrides may differ)`
        : "No new worktree for this transfer; future worktrees use the destination’s settings",
    ],
  ];
  return (
    <section
      aria-label="Workspace locations"
      className="min-w-0 space-y-3 rounded-lg border p-3 text-xs"
      data-slot="handoff-workspace-summary"
    >
      <h3 className="text-sm font-medium">Workspace locations</h3>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0 sm:contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground">
        {transferContext
          ? "Continuation uses the destination project folder (Local). New coding chats use the destination’s project worktree preferences."
          : "Copies files only; the coordinator stays on the source machine."}{" "}
        Worker worktrees stay on their original machine; their paths are history, not destination
        paths.
      </p>
      {copyRoot && (
        <p className="text-muted-foreground">
          Only the selected copy root is transferred. External worktrees and linked folders are
          excluded, even for an umbrella. Merge or checkpoint their work through the existing thread
          workflow before transferring coordinator context.
        </p>
      )}
      <p className="text-muted-foreground">
        Private application data, running processes and the live database are not project transfer
        content.
      </p>
    </section>
  );
}
