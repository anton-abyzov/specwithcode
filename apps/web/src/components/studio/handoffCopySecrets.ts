import type {
  FolderCopyRow,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import type { CopyMachine } from "./HandoffCopySetup";
import type { SecretFileRow } from "./HandoffSecretsStep";
import type { SecretsChoice } from "./handoffFolderCopyPending";

/** Secret files and repository choices, without UI: the dialog and the watcher share them. */

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

/** Which repository rows are cloned from origin and which are left out of the copy. */
export interface RepositoryChoices {
  readonly clone: ReadonlyArray<string>;
  readonly skip: ReadonlyArray<string>;
}

/** The repository choices the destination's plan holds now. */
export function planRepositoryChoices(rows: ReadonlyArray<FolderCopyRow>): RepositoryChoices {
  return {
    clone: rows.filter((row) => row.clone).map((row) => row.id),
    skip: rows.filter((row) => row.status === "skipped").map((row) => row.id),
  };
}

/** Secret files outside the repositories left out of the copy: those stay here anyway. */
export function secretFilesCopied(
  files: FolderCopySourceSummary["secretFiles"],
  copy: FolderCopyStatus,
  skip: ReadonlyArray<string>,
): FolderCopySourceSummary["secretFiles"] {
  const prefixes = copy.rows
    .filter((row) => skip.includes(row.id) && row.path !== ".")
    .map((row) => `${row.path}/`);
  if (prefixes.length === 0) return files;
  return files.filter((file) => !prefixes.some((prefix) => file.path.startsWith(prefix)));
}

/**
 * The secret files that can travel (receivable there, in repositories still copied) and
 * those that do: all but the ones unticked, or none when the line is off. Derived from the
 * choice, so a new measure never ticks a file the person unticked.
 */
export function travellingSecrets({
  summary,
  copy,
  skip,
  homeSupported,
  choice,
}: {
  readonly summary: FolderCopySourceSummary | null;
  readonly copy: FolderCopyStatus | null;
  readonly skip: ReadonlyArray<string>;
  readonly homeSupported: boolean;
  readonly choice: SecretsChoice;
}): { readonly candidates: ReadonlyArray<string>; readonly paths: ReadonlyArray<string> } {
  if (!summary) return { candidates: [], paths: [] };
  const files = copy ? secretFilesCopied(summary.secretFiles, copy, skip) : summary.secretFiles;
  const candidates = receivableSecretFiles(files, homeSupported).map((file) => file.path);
  const paths = choice.included ? candidates.filter((path) => !choice.out.includes(path)) : [];
  return { candidates, paths };
}

/**
 * What to send before an approval, from inputs read at that moment (the pointer's choice, the
 * latest plan, the destination), never a render that started a long run. An empty list
 * withdraws files sent before a refused approval; null when the source lists no secret file.
 */
export function sendableSecrets({
  summary,
  plan,
  repositories,
  machine,
  choice,
}: {
  readonly summary: FolderCopySourceSummary | null;
  readonly plan: FolderCopyStatus | null;
  readonly repositories: RepositoryChoices | null;
  readonly machine: CopyMachine | undefined;
  readonly choice: SecretsChoice;
}): ReadonlyArray<string> | null {
  if (!summary || summary.secretFiles.length === 0) return null;
  const skip = plan ? (repositories ?? planRepositoryChoices(plan.rows)).skip : [];
  const homeSupported = machine?.homeSecretFiles === true;
  return travellingSecrets({ summary, copy: plan, skip, homeSupported, choice }).paths;
}

/** The choice after the review's boxes change: the shown files left unticked join `out`. */
export const reviewedSecrets = (
  choice: SecretsChoice,
  candidates: ReadonlyArray<string>,
  included: boolean,
  paths: ReadonlyArray<string>,
): SecretsChoice =>
  included
    ? {
        included,
        out: [
          ...choice.out.filter((path) => !candidates.includes(path)),
          ...candidates.filter((path) => !paths.includes(path)),
        ],
      }
    : { included, out: choice.out };
