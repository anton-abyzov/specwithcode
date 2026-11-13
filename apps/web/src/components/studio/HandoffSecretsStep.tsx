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
 * Secret-like files (`.env`, keys, credentials, .NET user secrets) on the review. They
 * travel by default, shown as one checked line, "Secrets (.env, keys): N files, included";
 * Show lists each file with its own checkbox. Seeing the line checked is the consent: the
 * files go on Copy to the one machine named, readable only by your user there. Unticking
 * the line, or every file, leaves them on the source. Secrets kept in a vault or the
 * keychain are listed as not copied. Only paths and sizes show.
 */
export function HandoffSecretsStep({
  files: allFiles,
  hints = [],
  selected: chosen,
  included,
  sourceLabel,
  targetLabel,
  homeSupported,
  disabled,
  onSelectedChange,
  onIncludedChange,
}: {
  readonly files: ReadonlyArray<SecretFileRow>;
  readonly hints?: ReadonlyArray<SecretHintRow> | undefined;
  readonly selected: ReadonlyArray<string>;
  /** Secrets travel: on by default, from the setup screen's What comes along. */
  readonly included: boolean;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** The destination writes `~/` files into its home folder; older ones would not. */
  readonly homeSupported: boolean;
  readonly disabled: boolean;
  readonly onSelectedChange: (paths: ReadonlyArray<string>) => void;
  readonly onIncludedChange: (included: boolean) => void;
}) {
  const files = receivableSecretFiles(allFiles, homeSupported);
  // Only files this step shows can be sent: a ticked file it hides is unticked.
  const selected = chosen.filter((path) => files.some((file) => file.path === path));
  const hidden = chosen.length !== selected.length;
  // Included with nothing picked yet: every file is ticked, as the line says.
  const fill = included && chosen.length === 0 && files.length > 0;
  useEffect(() => {
    if (fill) onSelectedChange(files.map((file) => file.path));
    else if (hidden) onSelectedChange(selected);
  });
  const [shown, setShown] = useState(false);
  if (files.length === 0 && hints.length === 0) return null;
  const all = files.map((file) => file.path);
  const choose = (paths: ReadonlyArray<string>) => {
    const next = all.filter((path) => paths.includes(path));
    onSelectedChange(next);
    // Unticking every file is leaving the secrets here.
    if (next.length === 0) onIncludedChange(false);
  };
  const toggle = (path: string, on: boolean) =>
    choose(on ? [...selected, path] : selected.filter((item) => item !== path));
  const count = fill ? files.length : selected.length;
  const counted =
    included && count < files.length
      ? `${count} of ${files.length} files`
      : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return (
    <fieldset className="min-w-0 space-y-2 text-sm" data-slot="copy-secrets" disabled={disabled}>
      {files.length > 0 && (
        <>
          <div className="flex min-w-0 items-start justify-between gap-2">
            <label
              className="flex cursor-pointer items-start gap-2"
              data-slot="copy-secrets-include"
            >
              <span className="flex h-5 items-center">
                <Checkbox
                  checked={included}
                  disabled={disabled}
                  aria-label="Include secrets (.env, keys)"
                  onCheckedChange={(checked) => {
                    const on = checked === true;
                    onIncludedChange(on);
                    onSelectedChange(on ? all : []);
                  }}
                />
              </span>
              <span className="leading-5">
                Secrets (.env, keys): {counted}, {included ? "included" : `left on ${sourceLabel}`}
                <span className="block text-xs text-muted-foreground">
                  {included
                    ? `Copied to ${targetLabel}, where only your user can read them.`
                    : `They stay on ${sourceLabel}.`}{" "}
                  Sign-ins to Claude, Codex and GitHub are never copied; sign in on {targetLabel}{" "}
                  instead.
                </span>
              </span>
            </label>
            <button
              type="button"
              className="shrink-0 text-xs text-primary hover:underline"
              aria-expanded={shown}
              data-slot="copy-secrets-show"
              onClick={() => setShown((open) => !open)}
            >
              {shown ? "Hide" : "Show"}
            </button>
          </div>
          {shown && (
            <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border p-2">
              {files.map((file) => (
                <li key={file.path}>
                  <label className="flex min-w-0 cursor-pointer items-center gap-2">
                    <Checkbox
                      checked={included && (fill || selected.includes(file.path))}
                      disabled={disabled}
                      onCheckedChange={(checked) => {
                        if (checked === true && !included) {
                          onIncludedChange(true);
                          onSelectedChange([file.path]);
                          return;
                        }
                        toggle(file.path, checked === true);
                      }}
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
