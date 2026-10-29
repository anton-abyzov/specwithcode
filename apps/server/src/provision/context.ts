/** Shared types and paths for provisioning (runner, probe, plan, install). */
import type {
  ProvisionCredentialHelper,
  ProvisionEvent,
  ProvisionItemStatus,
  ProvisionProvider,
  ProvisionReadback,
  ProvisionService,
} from "@specweave-studio/contracts";

import type { ConnectLinkMode } from "../cloud/connectLinkMode.ts";
import type { ProvisionHost } from "./host.ts";
import type { ProvisionPlatformKey } from "./manifest.ts";
import type { CheckedTarget } from "./target.ts";

export const SYSTEMD_UNIT = "studio.service";
export const LAUNCHD_LABEL = "com.specweave.studio.service";
export const PATH_DROP_IN = "10-specwithcode-path.conf";
export const OUR_LAUNCHER_MARKER = "# specwithcode-provision launcher";

export interface ProvisionOptions {
  readonly dryRun: boolean;
  readonly resume: boolean;
  /** The version of the release running this command; the manifest ships with it. */
  readonly manifestVersion: string;
  /** The server version to install or verify; defaults to manifestVersion. */
  readonly serverVersion?: string;
  /** An explicit SpecWithCode home (--base-dir / STUDIO_HOME). */
  readonly baseDir?: string;
  /** `remote`: started from Settings > Connections inside the running server; never restarts it. */
  readonly mode: "cli" | "remote";
  /** macOS: ignore the desktop app and manage a command-line server (install.sh --standalone). */
  readonly standalone?: boolean;
  /** CLI only: restart the service to apply a PATH change, if it runs no threads. */
  readonly restartService?: boolean;
  /** The PATH a login shell gives the user, as the server reads it at start. */
  readonly loginShellPath: () => string | undefined;
  /** Remote mode: the running server's own PATH. */
  readonly serverPath?: string;
  /**
   * How this machine is linked to SpecWithCode Connect; read from the home's
   * secret files when not given. A managed link makes Tailscale optional.
   */
  readonly connectLinkMode?: ConnectLinkMode;
  /** `install`: plan Tailscale even when Connect reaches this machine; `skip`: never plan it. */
  readonly tailscale?: "auto" | "install" | "skip";
  /** The Node.js running this command. */
  readonly runtime: { readonly version: string; readonly execPath: string };
  readonly onEvent?: (event: ProvisionEvent) => void;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  manifestVersion: string;
  serverVersion: string;
  finished: boolean;
  steps: Record<string, { status: ProvisionItemStatus; at: string; detail: string | null }>;
}

export class ProvisionRunError extends Error {
  readonly code: "unsupported" | "busy" | "no-run-to-resume" | "failed";
  readonly readback: ProvisionReadback | undefined;
  constructor(
    code: "unsupported" | "busy" | "no-run-to-resume" | "failed",
    message: string,
    readback?: ProvisionReadback,
  ) {
    super(message);
    this.code = code;
    this.readback = readback;
  }
}

export type Probe = { found: string | null; path: string | null; detail?: string | null };

export const isLinux = (target: CheckedTarget) => target.platform === "linux";
export const join = (...parts: string[]) => parts.join("/").replace(/\/+/gu, "/");
export const dirname = (path: string) => path.replace(/\/[^/]+\/?$/u, "") || "/";

export interface Paths {
  readonly home: string;
  readonly homeSource: string;
  readonly binDir: string;
  readonly provisionDir: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly downloads: string;
  readonly unitPath: string;
  readonly plistPath: string;
}

export interface Ctx {
  readonly host: ProvisionHost;
  readonly options: ProvisionOptions;
  readonly target: CheckedTarget;
  readonly key: ProvisionPlatformKey;
  readonly paths: Paths;
  readonly wantedServer: string;
  readonly log: (line: string) => Promise<void>;
  readonly emit: (event: ProvisionEvent) => void;
}

export interface Probes {
  searchPath: string;
  git: Probe;
  gh: Probe & { ours: boolean | null };
  node: Probe;
  claude: Probe & { ours: boolean | null };
  codex: Probe & { ours: boolean | null };
  /** `found` is null when Tailscale is missing or its version could not be read; `path` tells them apart. */
  tailscale: Probe & { state: string | null };
  connect: ConnectLinkMode;
  server: Probe & { launchers: Record<string, string | null> };
  /** macOS: the desktop app or a managed launch agent that already runs the server. */
  manager: { kind: "desktop" | "managed"; label: string; version: string | null } | null;
  service: ProvisionService;
  servicePath: {
    effective: string;
    missing: string[];
    dropIn: boolean;
    /** The login shell gave no PATH in time; this command's own PATH stood in for it. */
    shellUnread: boolean;
  };
  linger: boolean | null;
  sleepMasked: boolean | null;
  providers: ProvisionProvider[];
  credentialHelper: ProvisionCredentialHelper;
}
