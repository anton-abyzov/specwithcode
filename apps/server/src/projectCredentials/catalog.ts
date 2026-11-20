/**
 * The closed list of credentials the copy dialog knows: how a project shows it
 * uses one, how a machine checks it has one, and the command a person runs to
 * get one. A project's manifest names entries from this list and can add
 * nothing to it, so opening a cloned project never makes a machine run a
 * command the project chose. The SSH row also shows where the project's
 * scripts connect (sshTargets.ts): user and host names held to strict
 * patterns, shown as unverified, inside commands only a person runs.
 *
 * Checks ask the tool that owns the sign-in, run in the home folder so no
 * project file configures it. Most read the tool's own local state; GitHub,
 * Cloudflare, npm and SSH ask their service, because only that says whether
 * the sign-in still works. A container registry sign-in has no single check
 * and answers `unknown`.
 *
 * Ready means the tool reports a sign-in on that machine. It does not show
 * that the account reaches this project's own registry, cluster or
 * subscription: npm is asked about its default registry only.
 */
import type {
  ProjectCredentialId,
  ProjectCredentialKind,
  ProjectCredentialSshHost,
} from "@specweave-studio/contracts";

export interface CredentialProbe {
  /** The tool's file name; resolved to an absolute path in a fixed list of folders. */
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  /**
   * `exit`: signed in when the command exits 0. `output`: exit 0 and anything
   * printed, for tools that exit 0 with nothing configured. `says`: for a tool
   * that exits 0 signed out, its own fixed sentence decides. The output is
   * looked at for emptiness or for those two sentences only, and dropped.
   */
  readonly readyWhen: "exit" | "output" | "says";
  /** For `says`: what the tool prints signed in and signed out. */
  readonly says?: { readonly signedIn: RegExp; readonly signedOut: RegExp };
  /**
   * What the tool prints on its error output when the service refused the
   * sign-in. With it, a failed run without that sentence (offline, a proxy, a
   * timeout) is no answer instead of "not signed in".
   */
  readonly refusal?: RegExp;
  /**
   * Sign-in variables the person's Terminal has that this tool reads
   * (`CLOUDFLARE_API_TOKEN`). Passed to this tool's check only, from the
   * login shell, and never kept in an answer.
   */
  readonly env?: ReadonlyArray<string>;
}

/** Variables every check gets from the person's Terminal: how to reach the network and their key agent. */
export const TERMINAL_NETWORK_VARIABLES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "SSH_AUTH_SOCK",
] as const;

/** The command-line tool a credential's commands run, and how a machine gets it. */
export interface CredentialTool {
  /** The file name it is found by. */
  readonly binary: string;
  /** Its npm package: installable with npm, and a project can bring it as a dependency. */
  readonly npmPackage: string | null;
  /** What follows `brew install` where Homebrew is there. */
  readonly brew: string | null;
  /** The maker's own installer, for a machine without Homebrew. */
  readonly installer: { readonly command: string; readonly newShell: boolean } | null;
}

const tool = (
  binary: string,
  how: Partial<Omit<CredentialTool, "binary">> = {},
): CredentialTool => ({ binary, npmPackage: null, brew: null, installer: null, ...how });

export interface CredentialEntry {
  readonly id: ProjectCredentialId;
  readonly kind: ProjectCredentialKind;
  readonly probe: CredentialProbe | null;
  /** Null where the commands are the system's own (`ssh-keygen`). */
  readonly tool: CredentialTool | null;
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
      env: ["GH_TOKEN", "GITHUB_TOKEN"],
    },
    signIn: same("gh auth login && gh auth setup-git"),
    tool: tool("gh", { brew: "gh" }),
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
    tool: tool("az", { brew: "azure-cli" }),
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
    tool: tool("gcloud", {
      brew: "--cask gcloud-cli",
      installer: { command: "curl https://sdk.cloud.google.com | bash", newShell: true },
    }),
    signIn: same("gcloud auth login --no-launch-browser"),
    check: "gcloud auth list",
    fileNames: [],
    terraformProviders: ["hashicorp/google", "hashicorp/google-beta"],
    scriptUse: /\b(?:gcloud|gsutil)\s+\S/u,
    remoteHosts: ["source.developers.google.com"],
  },
  {
    id: "aws",
    kind: "login",
    probe: { binary: "aws", args: ["configure", "list-profiles"], readyWhen: "output" },
    tool: tool("aws", { brew: "awscli" }),
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
    tool: tool("kubectl", { brew: "kubectl" }),
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
    tool: tool("hcloud", { brew: "hcloud" }),
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
    // wrangler exits 0 signed out, so its own sentence decides.
    probe: {
      binary: "wrangler",
      args: ["whoami"],
      readyWhen: "says",
      says: { signedIn: /You are logged in/u, signedOut: /You are not authenticated/u },
      env: [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CLOUDFLARE_ACCOUNT_ID",
      ],
    },
    tool: tool("wrangler", { npmPackage: "wrangler" }),
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
    // Asks the default registry who is signed in. A failure that is not the registry's
    // own refusal (offline, a proxy) is no answer.
    probe: {
      binary: "npm",
      args: ["whoami"],
      readyWhen: "exit",
      refusal: /\bENEEDAUTH\b|\bE401\b/u,
      // A home .npmrc may read its token from one of these.
      env: ["NPM_TOKEN", "NODE_AUTH_TOKEN"],
    },
    tool: tool("npm"),
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
    tool: tool("docker"),
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
    // Checked host by host against SSH_GIT_HOSTS, never with one command.
    probe: null,
    tool: null,
    signIn: {
      posix: "ssh-keygen -t ed25519",
      windows: "ssh-keygen -t ed25519",
    },
    // The dialog builds one check per place the project connects to; a placeholder is not a command.
    check: null,
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
  cloudflare: [
    ".wrangler/config/default.toml",
    ".config/.wrangler/config/default.toml",
    // Where wrangler keeps it on macOS.
    "Library/Preferences/.wrangler/config/default.toml",
  ],
  npm: [".npmrc"],
  docker: [".docker/config.json"],
  ssh: [".ssh/id_ed25519", ".ssh/id_rsa", ".ssh/config"],
};

/**
 * Sign-in files a tool keeps under `XDG_CONFIG_HOME` when the person set one,
 * relative to it. Looked for by name beside the home-folder places above.
 */
export const CREDENTIAL_XDG_FILES: Readonly<
  Partial<Record<ProjectCredentialId, ReadonlyArray<string>>>
> = {
  github: ["gh/hosts.yml"],
  "google-cloud": ["gcloud/credentials.db"],
  "hetzner-cloud": ["hcloud/cli.toml"],
  cloudflare: [".wrangler/config/default.toml"],
};

/**
 * The Git hosts an SSH check may contact, with the exit code `ssh -T git@host`
 * gives a key the host knows (GitHub answers 1 after its greeting) and the
 * host's published ed25519 key. The key is pinned so a first contact from a
 * new machine neither trusts whoever answers nor writes to `known_hosts`.
 */
export const SSH_GIT_HOSTS: Readonly<
  Record<ProjectCredentialSshHost, { readonly signedIn: number; readonly key: string }>
> = {
  "github.com": {
    signedIn: 1,
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  },
  "gitlab.com": {
    signedIn: 0,
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
  },
  "bitbucket.org": {
    signedIn: 0,
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
  },
};

/** Every variable asked of the login shell: the network ones and each check's own sign-in variables. */
export const TERMINAL_VARIABLES: ReadonlyArray<string> = [
  ...new Set([
    ...TERMINAL_NETWORK_VARIABLES,
    ...CREDENTIAL_CATALOG.flatMap((entry) => entry.probe?.env ?? []),
  ]),
];
