import { useEffect, useState } from "react";

import { formatBytes } from "../../studio/folderCopy";
import { Checkbox } from "../ui/checkbox";

export interface SecretFileRow {
  readonly path: string;
  readonly size: number;
}

export interface SecretHintRow {
  readonly path: string;
  readonly source: string;
  readonly hint: string;
}

/** A `~/` path is a file in the home folder (for example .NET user secrets), not in the project. */
export const isHomeSecretRow = (path: string) => path.startsWith("~/");

/**
 * The secret files a destination can receive. A `~/` file needs a destination
 * that writes it into its home folder; an older one would put it in the project,
 * so it is left out there.
 */
export function receivableSecretFiles<F extends SecretFileRow>(
  files: ReadonlyArray<F>,
  homeSupported: boolean,
): ReadonlyArray<F> {
  return homeSupported ? files : files.filter((file) => !isHomeSecretRow(file.path));
}

/**
 * The opt-in step for secret-like files (`.env`, keys, credentials, .NET user
 * secrets). They never travel with the folder: one "Include secrets" checkbox,
 * off by default, opens the per-file list, and the ticked ones are sent on Apply
 * after one confirmation naming the machine that receives them. Secrets kept in
 * a vault or the keychain are listed as not copied. Only paths and sizes show.
 */
export function HandoffSecretsStep({
  files: allFiles,
  hints = [],
  selected: chosen,
  confirmed,
  targetLabel,
  homeSupported,
  disabled,
  onSelectedChange,
  onConfirmedChange,
}: {
  readonly files: ReadonlyArray<SecretFileRow>;
  readonly hints?: ReadonlyArray<SecretHintRow> | undefined;
  readonly selected: ReadonlyArray<string>;
  readonly confirmed: boolean;
  readonly targetLabel: string;
  /** The destination writes `~/` files into its home folder; older ones would not. */
  readonly homeSupported: boolean;
  readonly disabled: boolean;
  readonly onSelectedChange: (paths: ReadonlyArray<string>) => void;
  readonly onConfirmedChange: (confirmed: boolean) => void;
}) {
  const files = receivableSecretFiles(allFiles, homeSupported);
  // Only files this step shows can be sent: a ticked file it hides is unticked.
  const selected = chosen.filter((path) => files.some((file) => file.path === path));
  const hidden = chosen.length !== selected.length;
  useEffect(() => {
    if (hidden) onSelectedChange(selected);
  });
  const [opened, setOpened] = useState(false);
  const included = opened || selected.length > 0;
  if (files.length === 0 && hints.length === 0) return null;
  const choose = (paths: ReadonlyArray<string>) => {
    onSelectedChange(files.map((file) => file.path).filter((path) => paths.includes(path)));
    onConfirmedChange(false);
  };
  const toggle = (path: string, on: boolean) =>
    choose(on ? [...selected, path] : selected.filter((item) => item !== path));
  return (
    <fieldset className="min-w-0 space-y-2 text-sm" data-slot="copy-secrets" disabled={disabled}>
      <legend className="mb-1 font-medium">Secret files</legend>
      {files.length > 0 && (
        <>
          <label className="flex cursor-pointer items-start gap-2" data-slot="copy-secrets-include">
            <span className="flex h-5 items-center">
              <Checkbox
                checked={included}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const on = checked === true;
                  setOpened(on);
                  choose(on ? files.map((file) => file.path) : []);
                }}
              />
            </span>
            <span className="leading-5">
              Include secrets (.env and similar)
              <span className="block text-xs text-muted-foreground">
                {files.length} {files.length === 1 ? "file looks" : "files look"} like passwords,
                keys or tokens, so they stay here unless you include them. Sign-ins to Claude, Codex
                and GitHub are never copied; sign in on {targetLabel} instead.
              </span>
            </span>
          </label>
          {included && (
            <>
              {files.length > 1 && (
                <div className="flex flex-wrap gap-2 text-xs" data-slot="copy-secrets-all">
                  <button
                    type="button"
                    disabled={disabled || files.every((file) => selected.includes(file.path))}
                    className="rounded border px-2 py-1 hover:bg-accent/40 disabled:opacity-50"
                    onClick={() => choose(files.map((file) => file.path))}
                  >
                    Tick all
                  </button>
                  <button
                    type="button"
                    disabled={disabled || selected.length === 0}
                    className="rounded border px-2 py-1 hover:bg-accent/40 disabled:opacity-50"
                    onClick={() => choose([])}
                  >
                    Untick all
                  </button>
                </div>
              )}
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
                      {isHomeSecretRow(file.path) && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          in your home folder
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(file.size)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {selected.length > 0 && (
            <label
              className="flex cursor-pointer items-start gap-2"
              data-slot="copy-secrets-confirm"
            >
              <span className="flex h-5 items-center">
                <Checkbox
                  checked={confirmed}
                  disabled={disabled}
                  onCheckedChange={(checked) => onConfirmedChange(checked === true)}
                />
              </span>
              <span className="leading-5">
                Send {selected.length} secret {selected.length === 1 ? "file" : "files"} to{" "}
                {targetLabel}. Only your user can read {selected.length === 1 ? "it" : "them"}{" "}
                there.
              </span>
            </label>
          )}
        </>
      )}
      {hints.length > 0 && (
        <div className="space-y-1" data-slot="copy-secrets-hints">
          <p className="text-xs text-muted-foreground">
            Not copied: these secrets live in a vault, the keychain or another machine's settings.
            Set them up on {targetLabel} yourself.
          </p>
          <ul className="space-y-1 rounded-lg border p-2 text-xs">
            {hints.map((hint) => (
              <li key={`${hint.source}:${hint.path}`} className="min-w-0">
                <span className="font-medium">{hint.source}</span>{" "}
                <span className="font-mono text-muted-foreground">{hint.path}</span>
                <span className="block text-muted-foreground">{hint.hint}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
