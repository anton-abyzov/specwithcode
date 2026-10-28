import type { ThreadEnvMode } from "@specweave-studio/contracts";

/** An explicit per-chat choice. Never rewrites a saved current-checkout choice. */
export function WorkspaceModeControl({
  mode,
  onChange,
  disabled = false,
}: {
  mode: ThreadEnvMode;
  onChange: (mode: ThreadEnvMode) => void;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex min-h-7 shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <input
        type="checkbox"
        aria-label="Use worktree"
        checked={mode === "worktree"}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked ? "worktree" : "local")}
        className="size-3.5 accent-primary"
      />
      <span>{mode === "worktree" ? "Use worktree" : "Current checkout"}</span>
    </label>
  );
}
