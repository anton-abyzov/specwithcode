/**
 * The state of first-run's "Your browser" row, from what this window can read
 * about Chrome on its own machine. The first state that applies is shown. The
 * first five have no action; the rest do.
 */

export type ChromeRowStateKind =
  | "loading"
  | "offline"
  | "team-rules"
  | "not-allowed"
  | "chrome-missing"
  | "approval"
  | "paired"
  | "not-answering"
  | "waiting"
  | "not-set-up";

export interface ChromeRowProfile {
  readonly id: string;
  readonly label: string;
  readonly extensionVersion: string;
  /** False for a copy loaded by hand; missing from servers that predate the check. */
  readonly fromStore?: boolean;
}

export interface ChromeRowStatus {
  readonly bundledVersion: string;
  /** Connected profiles. */
  readonly profiles: readonly ChromeRowProfile[];
  /** False only where the server looked and found no Chrome; a server that does not say counts as installed. */
  readonly chromeInstalled?: boolean;
  /** A profile has paired with the current code, connected or not. */
  readonly paired?: boolean;
  /** Other machines asking to use this Chrome. */
  readonly peers?: readonly {
    readonly id: string;
    readonly machine: string;
    readonly state: string;
  }[];
}

export interface ChromeRowInput {
  /** The machine's connection is up. */
  readonly online: boolean;
  /** Team rules turn the browser tools off here. */
  readonly teamRulesLocked: boolean;
  /** This window may read the status and request the pairing code. */
  readonly allowed: boolean;
  /** Null until the first status read. */
  readonly status: ChromeRowStatus | null;
  /** A code was copied or shown on this run and no profile has connected since. */
  readonly codeHandedOut: boolean;
}

export interface ChromeRowState {
  readonly kind: ChromeRowStateKind;
  /** The states that offer the row's own action. */
  readonly actionable: boolean;
  /** Paired profile names, in the server's order. */
  readonly paired: readonly string[];
  /** Paired profiles whose extension is older than the one this app was built with. */
  readonly outdated: readonly string[];
  /** Paired profiles running a copy loaded by hand. */
  readonly notFromStore: readonly string[];
  /** Paired profiles still called "Chrome" or "Chrome (n)", which agents cannot tell apart. */
  readonly unnamed: readonly string[];
  /** The machine waiting for an answer, in the approval state. */
  readonly asking: { readonly id: string; readonly machine: string } | null;
}

const ACTIONLESS: ReadonlySet<ChromeRowStateKind> = new Set([
  "loading",
  "offline",
  "team-rules",
  "not-allowed",
  "chrome-missing",
]);

/** Numeric dotted versions, compared part by part; anything unreadable counts as current. */
export function versionOlder(version: string, than: string): boolean {
  const parse = (value: string) =>
    value
      .trim()
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const a = parse(version);
  const b = parse(than);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * A profile still called by a default name: "Chrome", the extension's old
 * default, or "Unnamed profile", the relay's label for a nameless one, numbered
 * by the relay when repeated. Settings > Chrome and the first-run row share it.
 */
export function isDefaultProfileName(label: string): boolean {
  return /^(?:Chrome|Unnamed profile)(?: \(\d+\))?$/.test(label.trim());
}

export function chromeRowState(input: ChromeRowInput): ChromeRowState {
  const profiles = input.status?.profiles ?? [];
  const asking = input.status?.peers?.find((peer) => peer.state === "pending") ?? null;
  const kind: ChromeRowStateKind = !input.online
    ? "offline"
    : input.teamRulesLocked
      ? "team-rules"
      : !input.allowed
        ? "not-allowed"
        : input.status === null
          ? "loading"
          : input.status.chromeInstalled === false
            ? "chrome-missing"
            : asking !== null
              ? "approval"
              : profiles.length > 0
                ? "paired"
                : input.status.paired === true && !input.codeHandedOut
                  ? "not-answering"
                  : input.codeHandedOut
                    ? "waiting"
                    : "not-set-up";
  const bundled = input.status?.bundledVersion ?? "";
  return {
    kind,
    actionable: !ACTIONLESS.has(kind),
    paired: profiles.map((profile) => profile.label),
    outdated: profiles
      .filter((profile) => bundled !== "" && versionOlder(profile.extensionVersion, bundled))
      .map((profile) => profile.label),
    notFromStore: profiles.filter((profile) => profile.fromStore === false).map((p) => p.label),
    unnamed: profiles.filter((profile) => isDefaultProfileName(profile.label)).map((p) => p.label),
    asking: asking === null ? null : { id: asking.id, machine: asking.machine },
  };
}
