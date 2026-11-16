/**
 * The closed list of credentials the copy dialog knows: how a project shows it
 * uses one, how a machine checks it has one, and the command a person runs to
 * get one. A project's manifest names entries from this list and can add
 * nothing to it, so opening a cloned project never makes a machine run a
 * command the project chose.
 *
 * Checks are local reads of each tool's own state, with one stated exception
 * (GitHub asks github.com). Tools whose state sits in the Keychain, or whose
 * check would read project configuration (npm honours a project `.npmrc`),
 * have no check and answer `unknown`.
 */
import type { ProjectCredentialId, ProjectCredentialKind } from "@specweave-studio/contracts";

export interface CredentialProbe {
  /** The tool's file name; resolved to an absolute path in a fixed list of folders. */
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  /**
   * `exit`: signed in when the command exits 0. `output`: exit 0 and anything
   * printed, for tools that exit 0 with nothing configured. The output is
   * looked at for emptiness only and dropped.
   */
  readonly readyWhen: "exit" | "output";
}

export interface CredentialEntry {
  readonly id: ProjectCredentialId;
  readonly kind: ProjectCredentialKind;
  readonly probe: CredentialProbe | null;
  /** What the person runs on the machine that lacks it. */
  readonly signIn: { readonly posix: string; readonly windows: string };
  /** How to see whether it worked, where the app has no check of its own. */
  readonly check: string | null;
  /** File names that show the project uses it, matched by name alone and never read. */
  readonly fileNames: ReadonlyArray<RegExp>;
  /** Terraform provider sources (`hashicorp/azurerm`). */
  readonly terraformProviders: ReadonlyArray<string>;
  /** Command use in scripts and workflow files. */
  readonly scriptUse: RegExp | null;
  /** Remote hosts of the project's Git repositories. */
  readonly remoteHosts: ReadonlyArray<string>;
}

const same = (command: string) => ({ posix: command, windows: command });

export const CREDENTIAL_CATALOG: ReadonlyArray<CredentialEntry> = [
  {
    id: "github",
    kind: "login",
    probe: {
      binary: "gh",
      args: ["auth", "status", "--hostname", "github.com"],
      readyWhen: "exit",
    },
    signIn: same("gh auth login && gh auth setup-git"),
    check: null,
    fileNames: [],
    terraformProviders: ["integrations/github"],
    scriptUse: /\bgh\s+(?:pr|release|auth|api|run|workflow|repo)\b/u,
    remoteHosts: ["github.com"],
  },
  {
    id: "azure",
    kind: "login",
    probe: { binary: "az", args: ["account", "show", "--output", "none"], readyWhen: "exit" },
    signIn: same("az login --use-device-code"),
    check: null,
    fileNames: [],
    terraformProviders: ["hashicorp/azurerm", "hashicorp/azuread", "azure/azapi"],
    scriptUse: /\baz\s+(?:login|aks|acr|account|group|storage|keyvault|webapp)\b/u,
    remoteHosts: ["dev.azure.com", "ssh.dev.azure.com"],
  },
  {
    id: "google-cloud",
    kind: "login",
    probe: {
      binary: "gcloud",
      args: ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
      readyWhen: "output",
    },
    signIn: same("gcloud auth login --no-launch-browser"),
    check: null,
    fileNames: [],
    terraformProviders: ["hashicorp/google", "hashicorp/google-beta"],
    scriptUse: /\b(?:gcloud|gsutil)\s+\S/u,
    remoteHosts: ["source.developers.google.com"],
  },
  {
    id: "aws",
    kind: "login",
    probe: { binary: "aws", args: ["configure", "list-profiles"], readyWhen: "output" },
    signIn: same("aws configure sso"),
    check: null,
    fileNames: [],
    terraformProviders: ["hashicorp/aws"],
    scriptUse: /\baws\s+(?:s3|ecr|sts|eks|ssm|lambda|cloudformation|sso)\b/u,
    remoteHosts: [],
  },
  {
    id: "kubernetes",
    kind: "login",
    probe: {
      binary: "kubectl",
      args: ["config", "get-contexts", "--output", "name"],
      readyWhen: "output",
    },
    signIn: same(
      "az aks get-credentials --resource-group <group> --name <cluster>   (or your provider's get-credentials command)",
    ),
    check: null,
    fileNames: [/^Chart\.ya?ml$/u, /^kustomization\.ya?ml$/u, /^helmfile\.ya?ml$/u],
    terraformProviders: ["hashicorp/kubernetes", "hashicorp/helm"],
    scriptUse: /\bKUBECONFIG\b|\b(?:kubectl|helm|argocd|flux)\s+\S/u,
    remoteHosts: [],
  },
  {
    id: "hetzner-cloud",
    kind: "login",
    probe: { binary: "hcloud", args: ["context", "active"], readyWhen: "output" },
    signIn: same("hcloud context create <name>   (paste a new API token made for this machine)"),
    check: null,
    fileNames: [],
    terraformProviders: ["hetznercloud/hcloud"],
    scriptUse: /\bhcloud\s+\S|\bHCLOUD_TOKEN\b/u,
    remoteHosts: [],
  },
  {
    id: "cloudflare",
    kind: "login",
    probe: null,
    signIn: same("wrangler login"),
    check: "wrangler whoami",
    fileNames: [/^wrangler\.(?:toml|jsonc?)$/u],
    terraformProviders: ["cloudflare/cloudflare"],
    scriptUse: /\bwrangler\s+(?:deploy|publish|pages|d1|r2|kv|secret)\b/u,
    remoteHosts: [],
  },
  {
    id: "npm",
    kind: "login",
    probe: null,
    signIn: same("npm login"),
    check: "npm whoami",
    fileNames: [/^\.npmrc$/u],
    terraformProviders: [],
    scriptUse: /\b(?:npm|pnpm)\s+publish\b/u,
    remoteHosts: [],
  },
  {
    id: "docker",
    kind: "login",
    probe: null,
    signIn: same("docker login <registry>"),
    check: "docker pull <an image of this project>",
    fileNames: [],
    terraformProviders: [],
    scriptUse: /\bdocker\s+(?:login|push)\b/u,
    remoteHosts: [],
  },
  {
    id: "ssh",
    kind: "file",
    probe: null,
    signIn: {
      posix: "ssh-keygen -t ed25519",
      windows: "ssh-keygen -t ed25519",
    },
    check: "ssh <host> true",
    fileNames: [/^ansible\.cfg$/u],
    terraformProviders: [],
    // Script destinations are read in sshTargets.ts, which also says where they point.
    scriptUse: /\bansible_ssh_private_key_file\b/u,
    remoteHosts: [],
  },
];

const BY_ID = new Map(CREDENTIAL_CATALOG.map((entry) => [entry.id, entry]));

/** The entry for an id from the wire; undefined for anything the list does not hold. */
export const credentialEntry = (id: string): CredentialEntry | undefined =>
  BY_ID.get(id as ProjectCredentialId);

export const signInCommand = (entry: CredentialEntry, platform: NodeJS.Platform) =>
  platform === "win32" ? entry.signIn.windows : entry.signIn.posix;

/**
 * Where each credential is kept in a home folder, relative to it. Named so the
 * dialog can say what stayed behind and a test can hold the copy to refusing
 * every one; nothing here is opened, listed or sent.
 */
export const CREDENTIAL_HOME_FILES: Readonly<Record<ProjectCredentialId, ReadonlyArray<string>>> = {
  github: [".config/gh/hosts.yml", ".git-credentials"],
  azure: [".azure/msal_token_cache.json", ".azure/azureProfile.json"],
  "google-cloud": [
    ".config/gcloud/credentials.db",
    ".config/gcloud/application_default_credentials.json",
  ],
  aws: [".aws/credentials", ".aws/config"],
  kubernetes: [".kube/config"],
  "hetzner-cloud": [".config/hcloud/cli.toml"],
  cloudflare: [".wrangler/config/default.toml", ".config/.wrangler/config/default.toml"],
  npm: [".npmrc"],
  docker: [".docker/config.json"],
  ssh: [".ssh/id_ed25519", ".ssh/id_rsa", ".ssh/config"],
};
