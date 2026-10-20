import { formatBytes } from "../../studio/folderCopy";
import { Checkbox } from "../ui/checkbox";

export interface SecretFileRow {
  readonly path: string;
  readonly size: number;
}

/**
 * The opt-in step for secret-like files (`.env`, keys, credentials). They never
 * travel with the folder; each one the person ticks is sent on Apply, after one
 * confirmation naming the machine that receives it. Only paths and sizes show.
 */
export function HandoffSecretsStep({
  files,
  selected,
  confirmed,
  targetLabel,
  disabled,
  onSelectedChange,
  onConfirmedChange,
}: {
  readonly files: ReadonlyArray<SecretFileRow>;
  readonly selected: ReadonlyArray<string>;
  readonly confirmed: boolean;
  readonly targetLabel: string;
  readonly disabled: boolean;
  readonly onSelectedChange: (paths: ReadonlyArray<string>) => void;
  readonly onConfirmedChange: (confirmed: boolean) => void;
}) {
  if (files.length === 0) return null;
  const toggle = (path: string, on: boolean) => {
    const next = on ? [...selected, path] : selected.filter((item) => item !== path);
    onSelectedChange(files.map((file) => file.path).filter((item) => next.includes(item)));
    onConfirmedChange(false);
  };
  return (
    <fieldset className="min-w-0 space-y-2 text-sm" data-slot="copy-secrets" disabled={disabled}>
      <legend className="mb-1 font-medium">Secret files</legend>
      <p className="text-xs text-muted-foreground">
        These files look like passwords, keys or tokens, so they stay here unless you tick them.
        Sign-ins to Claude, Codex and GitHub are never copied; sign in on {targetLabel} instead.
      </p>
      <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border p-2">
        {files.map((file) => (
          <li key={file.path}>
            <label className="flex min-w-0 cursor-pointer items-center gap-2">
              <Checkbox
                checked={selected.includes(file.path)}
                disabled={disabled}
                onCheckedChange={(checked) => toggle(file.path, checked === true)}
                aria-label={`Send ${file.path}`}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {selected.length > 0 && (
        <label className="flex cursor-pointer items-start gap-2" data-slot="copy-secrets-confirm">
          <span className="flex h-5 items-center">
            <Checkbox
              checked={confirmed}
              disabled={disabled}
              onCheckedChange={(checked) => onConfirmedChange(checked === true)}
            />
          </span>
          <span className="leading-5">
            Send{" "}
            {selected.length === 1 ? "this secret file" : `these ${selected.length} secret files`}{" "}
            to {targetLabel}. They arrive readable only by your user there.
          </span>
        </label>
      )}
    </fieldset>
  );
}
