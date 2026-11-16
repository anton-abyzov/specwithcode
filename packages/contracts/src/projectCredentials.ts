import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId } from "./baseSchemas.ts";

/**
 * The sign-ins and key files a project uses from outside its folder: GitHub,
 * cloud command-line tools, Kubernetes contexts, registries, SSH keys. A copy
 * to another machine never carries them. The source lists which ones the
 * project uses, by file names and tool markers only; the destination says
 * whether it already has each one. No value, account name or command output
 * ever crosses the wire, and no key, public or private.
 *
 * One kind of name does cross, from the source to the dialog: where the
 * project's scripts and Git remotes connect over SSH (user and host names, or
 * the name of the shell variable that holds the host). A caller that may read
 * the project folder could read the same scripts.
 *
 * The list of credentials is closed: a project's manifest can name an entry
 * and add a short note, and nothing in it can change a command.
 */
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const PROJECT_CREDENTIAL_IDS = [
  "github",
  "azure",
  "google-cloud",
  "aws",
  "kubernetes",
  "hetzner-cloud",
  "cloudflare",
  "npm",
  "docker",
  "ssh",
] as const;
export const ProjectCredentialId = Schema.Literals(PROJECT_CREDENTIAL_IDS);
export type ProjectCredentialId = typeof ProjectCredentialId.Type;

/** Product names, shown as they are in every language. */
export const PROJECT_CREDENTIAL_LABELS: Readonly<Record<ProjectCredentialId, string>> = {
  github: "GitHub",
  azure: "Azure",
  "google-cloud": "Google Cloud",
  aws: "AWS",
  kubernetes: "Kubernetes",
  "hetzner-cloud": "Hetzner Cloud",
  cloudflare: "Cloudflare",
  npm: "npm",
  docker: "Container registry",
  ssh: "SSH keys",
};

/** `login`: a sign-in each machine does itself. `file`: key files that stay on the machine that has them. */
export const ProjectCredentialKind = Schema.Literals(["login", "file"]);
export type ProjectCredentialKind = typeof ProjectCredentialKind.Type;

/** `unknown`: this machine has no safe local check for it, or the check gave no answer. */
export const ProjectCredentialStatus = Schema.Literals([
  "ready",
  "not_signed_in",
  "tool_missing",
  "unknown",
]);
export type ProjectCredentialStatus = typeof ProjectCredentialStatus.Type;

export const PROJECT_CREDENTIALS_MANIFEST_PATH = ".specweave/project/credentials.json";
export const MAX_MANIFEST_ENTRIES = 100;
export const MAX_MANIFEST_NOTE = 120;
export const MAX_MANIFEST_BYTES = 64 * 1024;

export interface ProjectCredentialsManifestEntry {
  readonly id: ProjectCredentialId;
  /** The person marked it as not needed on other machines. */
  readonly skip?: boolean;
  /** A short reminder in the person's words, shown as plain text. */
  readonly note?: string;
}
export interface ProjectCredentialsManifest {
  readonly version: 1;
  readonly credentials: ReadonlyArray<ProjectCredentialsManifestEntry>;
}

/** Control, bidirectional and other format characters: they can disguise text shown beside a command. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * Formats secret scanners match, plus long unbroken base64 or hex. A lint
 * only: what keeps values out is that a manifest holds ids and a short note.
 */
const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u,
  /\bglpat-[A-Za-z0-9_-]{20}/u,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/u,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/u,
  /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /[A-Za-z0-9+/_=-]{32,}/u,
];

export const looksLikeToken = (text: string) => TOKEN_SHAPES.some((shape) => shape.test(text));

/** Why a note cannot be kept, or null. Never repeats the note. */
export function projectCredentialNoteProblem(note: string): string | null {
  if (note.length > MAX_MANIFEST_NOTE) return `is longer than ${MAX_MANIFEST_NOTE} characters`;
  if (UNSAFE_TEXT.test(note)) return "holds control or formatting characters";
  if (looksLikeToken(note)) return "looks like a secret value; a manifest never holds one";
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ID_SET: ReadonlySet<string> = new Set(PROJECT_CREDENTIAL_IDS);
const ENTRY_KEYS: ReadonlySet<string> = new Set(["id", "skip", "note"]);
const TOP_KEYS: ReadonlySet<string> = new Set(["version", "credentials"]);

export type ProjectCredentialsManifestResult =
  | { readonly ok: true; readonly manifest: ProjectCredentialsManifest }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a manifest strictly: an unknown key, an unknown id or unsafe text
 * refuses the whole file. The problem names the entry and field, never the
 * text found there.
 */
export function parseProjectCredentialsManifest(value: unknown): ProjectCredentialsManifestResult {
  const fail = (problem: string) => ({ ok: false as const, problem });
  if (!isRecord(value)) return fail("The file is not a JSON object.");
  for (const key of Object.keys(value))
    if (!TOP_KEYS.has(key)) return fail("The file has a key that is not version or credentials.");
  if (value.version !== 1) return fail("version must be 1.");
  if (!Array.isArray(value.credentials)) return fail("credentials must be a list.");
  if (value.credentials.length > MAX_MANIFEST_ENTRIES)
    return fail(`credentials lists more than ${MAX_MANIFEST_ENTRIES} entries.`);
  const seen = new Set<string>();
  const credentials: Array<ProjectCredentialsManifestEntry> = [];
  for (const [index, raw] of value.credentials.entries()) {
    const at = `Entry ${index + 1}`;
    if (!isRecord(raw)) return fail(`${at} is not an object.`);
    for (const key of Object.keys(raw))
      if (!ENTRY_KEYS.has(key)) return fail(`${at} has a key that is not id, skip or note.`);
    if (typeof raw.id !== "string" || !ID_SET.has(raw.id))
      return fail(`${at}: id is not a credential SpecWithCode knows.`);
    if (seen.has(raw.id)) return fail(`${at}: id is listed twice.`);
    seen.add(raw.id);
    if (raw.skip !== undefined && typeof raw.skip !== "boolean")
      return fail(`${at}: skip must be true or false.`);
    if (raw.note !== undefined) {
      if (typeof raw.note !== "string") return fail(`${at}: note must be text.`);
      const problem = projectCredentialNoteProblem(raw.note);
      if (problem !== null) return fail(`${at}: note ${problem}.`);
    }
    credentials.push({
      id: raw.id as ProjectCredentialId,
      ...(raw.skip === true ? { skip: true } : {}),
      ...(typeof raw.note === "string" && raw.note.trim() !== "" ? { note: raw.note.trim() } : {}),
    });
  }
  return { ok: true, manifest: { version: 1, credentials } };
}

/** The manifest as saved: stable key order, one entry per line group, trailing newline. */
export const formatProjectCredentialsManifest = (manifest: ProjectCredentialsManifest) =>
  `${JSON.stringify(
    {
      version: 1,
      credentials: manifest.credentials.map((entry) => ({
        id: entry.id,
        ...(entry.skip ? { skip: true } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      })),
    },
    null,
    2,
  )}\n`;

const SSH_HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const SSH_HOST = new RegExp(`^${SSH_HOST_LABEL}(?:\\.${SSH_HOST_LABEL})*$`, "u");
const SSH_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/u;
const SHELL_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const PRIVATE_IPV4 =
  /^(?:10|127)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^0\./u;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;
const NUMBER_LABEL = /^(?:0x[0-9a-f]+|[0-9]+)$/iu;
/**
 * A host made of numbers that is not a plain dotted address: `0177.0.0.1`,
 * `0x7f000001` and `2130706433` all reach 127.0.0.1 while reading as something else.
 */
const oddNumber = (host: string) =>
  !IPV4.test(host) && NUMBER_LABEL.test(host.slice(host.lastIndexOf(".") + 1));
export const MAX_SSH_TARGETS = 12;

/**
 * A host name or IPv4 address in plain ASCII letters, digits, dots and inner
 * hyphens. A project's files supply these and they end up inside commands a
 * person copies, so nothing else passes: no leading hyphen (an ssh option), no
 * quote, space or shell character, no port, no bracket, no non-ASCII look-alike.
 */
export const isSafeSshHost = (value: string) =>
  value.length <= 253 && SSH_HOST.test(value) && !looksLikeToken(value) && !oddNumber(value);
export const isSafeSshUser = (value: string) => SSH_USER.test(value);
export const isShellVariableName = (value: string) => SHELL_VARIABLE.test(value);
/** Text free of control, bidirectional and other format characters. */
export const isPlainText = (value: string) => !UNSAFE_TEXT.test(value);
/** This machine itself or an address inside a private network: worth a second look in a cloned project. */
export const isPrivateSshHost = (host: string) =>
  host.toLowerCase() === "localhost" || (/^[0-9.]+$/u.test(host) && PRIVATE_IPV4.test(host));

/**
 * Where a project's scripts or Git remotes connect over SSH. `server` and
 * `git` carry a host; `variable` names the shell variable a script takes its
 * host from when the script does not say; on a `server` it names the variable
 * whose written value the host is. Names only: the patterns are part of the
 * schema, applied by the machine that reads them and again where they are shown.
 */
export const ProjectSshTarget = Schema.Struct({
  kind: Schema.Literals(["server", "git", "variable"]),
  user: Schema.NullOr(bounded(32).check(Schema.isPattern(SSH_USER))),
  host: Schema.NullOr(bounded(253).check(Schema.isPattern(SSH_HOST))),
  variable: Schema.NullOr(bounded(64).check(Schema.isPattern(SHELL_VARIABLE))),
  /** Project-relative file that showed it. */
  source: bounded(4096),
});
export type ProjectSshTarget = typeof ProjectSshTarget.Type;

/** A target as it may be shown: the right fields for its kind, every one of them safe. */
export function isSafeSshTarget(target: ProjectSshTarget): boolean {
  if (target.user !== null && !isSafeSshUser(target.user)) return false;
  if (target.variable !== null && !isShellVariableName(target.variable)) return false;
  if (!isPlainText(target.source)) return false;
  if (target.kind === "variable") return target.host === null && target.variable !== null;
  if (target.kind === "git" && target.variable !== null) return false;
  return target.host !== null && isSafeSshHost(target.host);
}

/** One credential the project uses, and what in the folder shows it. */
export const ProjectCredentialRow = Schema.Struct({
  id: ProjectCredentialId,
  kind: ProjectCredentialKind,
  /** Project-relative files that showed it, a few at most. Empty when only the manifest lists it. */
  sources: Schema.Array(bounded(4096)),
  /** The saved manifest lists it. */
  listed: Schema.Boolean,
  skip: Schema.Boolean,
  note: Schema.NullOr(bounded(MAX_MANIFEST_NOTE)),
  /** Home-folder places it is usually kept (`.kube/config`). Names from the app's list; a copy never reads or sends them. */
  keptIn: Schema.Array(bounded(200)),
  /** SSH only: where the project connects. Absent from a machine that predates it. */
  sshTargets: Schema.optional(
    Schema.Array(ProjectSshTarget).check(Schema.isMaxLength(MAX_SSH_TARGETS)),
  ),
  /** SSH only: the project connects to more places than `sshTargets` lists. */
  sshTargetsMore: Schema.optional(Schema.Boolean),
});
export type ProjectCredentialRow = typeof ProjectCredentialRow.Type;

export const ProjectCredentialsScanInput = Schema.Struct({ projectId: ProjectId });
export type ProjectCredentialsScanInput = typeof ProjectCredentialsScanInput.Type;
export const ProjectCredentialsScan = Schema.Struct({
  rows: Schema.Array(ProjectCredentialRow),
  /** Why the saved manifest was not used; the scan's own rows still stand. */
  manifestProblem: Schema.NullOr(bounded(400)),
  /** The folder was too large to read in full; more may apply. */
  truncated: Schema.Boolean,
});
export type ProjectCredentialsScan = typeof ProjectCredentialsScan.Type;

const SavedEntry = Schema.Struct({
  id: ProjectCredentialId,
  skip: Schema.optional(Schema.Boolean),
  note: Schema.optional(bounded(MAX_MANIFEST_NOTE)),
});
export const ProjectCredentialsSaveInput = Schema.Struct({
  projectId: ProjectId,
  credentials: Schema.Array(SavedEntry).check(Schema.isMaxLength(MAX_MANIFEST_ENTRIES)),
});
export type ProjectCredentialsSaveInput = typeof ProjectCredentialsSaveInput.Type;
export const ProjectCredentialsSaveResult = Schema.Struct({
  /** Project-relative path of the manifest. */
  path: bounded(200),
});
export type ProjectCredentialsSaveResult = typeof ProjectCredentialsSaveResult.Type;

export const ProjectCredentialsProbeInput = Schema.Struct({
  ids: Schema.Array(ProjectCredentialId).check(Schema.isMaxLength(PROJECT_CREDENTIAL_IDS.length)),
  /** Ask again instead of answering from the last minute's result. */
  fresh: Schema.optional(Schema.Boolean),
});
export type ProjectCredentialsProbeInput = typeof ProjectCredentialsProbeInput.Type;

/** This machine's answer for one credential: a status and its own platform's commands. */
export const ProjectCredentialProbe = Schema.Struct({
  id: ProjectCredentialId,
  status: ProjectCredentialStatus,
  /** The command that signs this machine in, or creates its own key. From the app's list only. */
  signIn: bounded(300),
  /** The command that shows whether it worked, when the app does not check it itself. */
  check: Schema.NullOr(bounded(300)),
});
export type ProjectCredentialProbe = typeof ProjectCredentialProbe.Type;
export const ProjectCredentialsProbeResult = Schema.Struct({
  results: Schema.Array(ProjectCredentialProbe),
});
export type ProjectCredentialsProbeResult = typeof ProjectCredentialsProbeResult.Type;

export class ProjectCredentialsError extends Schema.TaggedError<ProjectCredentialsError>()(
  "ProjectCredentialsError",
  {
    /** `busy`: checked too often; wait a minute. */
    code: Schema.Literals(["not_found", "invalid", "busy", "refused", "failed"]),
    reason: bounded(600),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const PROJECT_CREDENTIALS_RPC_METHODS = {
  projectCredentialsScan: "projectCredentials.scan",
  projectCredentialsSave: "projectCredentials.save",
  projectCredentialsProbe: "projectCredentials.probe",
} as const;

const error = Schema.Union([ProjectCredentialsError, EnvironmentAuthorizationError]);
export const projectCredentialsRpcs = [
  Rpc.make(PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsScan, {
    payload: ProjectCredentialsScanInput,
    success: ProjectCredentialsScan,
    error,
  }),
  Rpc.make(PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsSave, {
    payload: ProjectCredentialsSaveInput,
    success: ProjectCredentialsSaveResult,
    error,
  }),
  Rpc.make(PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsProbe, {
    payload: ProjectCredentialsProbeInput,
    success: ProjectCredentialsProbeResult,
    error,
  }),
] as const;
