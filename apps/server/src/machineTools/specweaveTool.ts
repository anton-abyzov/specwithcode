// @effect-diagnostics nodeBuiltinImport:off - plain async I/O like provisioning; Effect wraps it at the RPC edge.
/**
 * The SpecWeave CLI for machine readiness: its version wherever it is, and an
 * install of the pinned release into the app's own folder.
 *
 * The install runs npm's own JavaScript with a Node.js binary, never `npm.cmd`
 * or a shell, so it works the same on Windows, from a service with a narrow
 * PATH, and with no admin rights: `npm install --global --prefix` writes only
 * under `<home>/tools/specweave/<version>`. npm checks the package against the
 * registry's sha512 integrity. The person's own `specweave` is never replaced.
 */
import * as NodePath from "node:path";

import type { ProvisionHost } from "../provision/host.ts";
import { SPECWEAVE_VERSION } from "../provision/manifest.ts";

const pathFor = (platform: string) => (platform === "win32" ? NodePath.win32 : NodePath.posix);

/** The npm `--prefix` the app installs the current SpecWeave pin into. */
export function managedSpecweavePrefix(home: string, platform: string): string {
  return pathFor(platform).join(home, "tools", "specweave", SPECWEAVE_VERSION);
}

/** The folder that holds `specweave` once the app has installed it. npm puts Windows shims at the prefix's top. */
export function managedSpecweaveDir(home: string, platform: string): string {
  const prefix = managedSpecweavePrefix(home, platform);
  return platform === "win32" ? prefix : pathFor(platform).join(prefix, "bin");
}

/** Where `npm --prefix` puts a global package: `<prefix>/node_modules` on Windows, `<prefix>/lib/node_modules` elsewhere. */
const packageDir = (platform: string, prefix: string) =>
  platform === "win32"
    ? NodePath.win32.join(prefix, "node_modules", "specweave")
    : NodePath.posix.join(prefix, "lib", "node_modules", "specweave");

async function readVersion(
  host: Pick<ProvisionHost, "readText">,
  packageJson: string,
): Promise<string | null> {
  const text = await host.readText(packageJson);
  if (text === null) return null;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/u.test(version)
      ? /^\d+\.\d+\.\d+/u.exec(version)![0]
      : null;
  } catch {
    return null;
  }
}

/**
 * The version of the `specweave` found at `command`, read from its
 * package.json, so no shim or `.cmd` has to run: npm's Windows shim sits next
 * to `node_modules`, and elsewhere the command links to `bin/specweave.js`.
 */
export async function specweaveVersionAt(
  host: Pick<ProvisionHost, "platform" | "readText" | "realPath">,
  command: string,
): Promise<string | null> {
  const path = pathFor(host.platform);
  if (host.platform === "win32")
    return readVersion(
      host,
      path.join(path.dirname(command), "node_modules", "specweave", "package.json"),
    );
  const real = (await host.realPath(command)) ?? command;
  return readVersion(host, path.join(path.dirname(path.dirname(real)), "package.json"));
}

/** npm's own entry next to a Node.js binary, following links (Homebrew, nvm). */
export async function npmCliFor(
  host: Pick<ProvisionHost, "platform" | "exists" | "realPath">,
  node: string,
): Promise<string | null> {
  const path = pathFor(host.platform);
  const real = (await host.realPath(node)) ?? node;
  const candidates =
    host.platform === "win32"
      ? [path.join(path.dirname(real), "node_modules", "npm", "bin", "npm-cli.js")]
      : [
          path.join(
            path.dirname(path.dirname(real)),
            "lib",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
          "/usr/share/nodejs/npm/bin/npm-cli.js",
          "/usr/lib/node_modules/npm/bin/npm-cli.js",
        ];
  for (const candidate of candidates) if (await host.exists(candidate)) return candidate;
  return null;
}

export interface SpecweaveInstallContext {
  readonly host: ProvisionHost;
  readonly home: string;
}

export class SpecweaveInstallFailure extends Error {
  readonly code: "unsupported" | "failed";
  constructor(code: "unsupported" | "failed", message: string) {
    super(message);
    this.code = code;
  }
}

const tail = (result: { stdout: string; stderr: string }) =>
  `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/u).slice(-4).join(" ").slice(0, 600);

/**
 * Installs the pinned SpecWeave into a staging prefix, checks that it reports
 * the pinned version, then moves it into place, so a stopped install never
 * leaves half a package behind. The caller holds the install lock.
 */
export async function installSpecweave<C extends SpecweaveInstallContext>(
  ctx: C,
  log: (line: string) => void,
  findNode: (ctx: C) => Promise<string | null>,
): Promise<{ handedOff: false; detail: string; pathDirs: ReadonlyArray<string> }> {
  const { host } = ctx;
  const path = pathFor(host.platform);
  const node = await findNode(ctx);
  if (node === null)
    throw new SpecweaveInstallFailure(
      "unsupported",
      "SpecWeave runs on Node.js, which this machine does not have. Install Node.js first.",
    );
  const npmCli = await npmCliFor(host, node);
  if (npmCli === null)
    throw new SpecweaveInstallFailure(
      "unsupported",
      `The Node.js at ${node} has no npm next to it. Install Node.js from nodejs.org, or let SpecWithCode install its own.`,
    );
  const prefix = managedSpecweavePrefix(ctx.home, host.platform);
  const staging = `${prefix}.staging`;
  await host.remove(staging);
  await host.mkdirp(staging);
  const pkg = `specweave@${SPECWEAVE_VERSION}`;
  log(`$ npm install --global --prefix ${prefix} ${pkg}`);
  try {
    const delimiter = host.platform === "win32" ? ";" : ":";
    const pathKey = Object.keys(host.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const result = await host.exec(
      node,
      [
        npmCli,
        "install",
        "--global",
        "--prefix",
        staging,
        "--no-audit",
        "--no-fund",
        // A person's npm config may turn command links off; the app needs the command.
        "--bin-links=true",
        "--loglevel=error",
        pkg,
      ],
      {
        timeoutMs: 10 * 60_000,
        onLine: log,
        // npm's lifecycle scripts look for `node` on the PATH, and run through
        // `sh` outside Windows, which a service's narrow PATH may not reach.
        env: {
          [pathKey]: [
            path.dirname(node),
            host.env[pathKey] ?? "",
            ...(host.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
          ]
            .filter((entry) => entry !== "")
            .join(delimiter),
        },
      },
    );
    if (result.code !== 0)
      throw new SpecweaveInstallFailure(
        "failed",
        `npm could not install SpecWeave: ${tail(result)}`,
      );
    const version = await readVersion(
      host,
      path.join(packageDir(host.platform, staging), "package.json"),
    );
    if (version !== SPECWEAVE_VERSION)
      throw new SpecweaveInstallFailure(
        "failed",
        `npm installed SpecWeave ${version ?? "with no version"} instead of ${SPECWEAVE_VERSION}.`,
      );
    const command =
      host.platform === "win32"
        ? path.join(staging, "specweave.cmd")
        : path.join(staging, "bin", "specweave");
    if (!(await host.exists(command)))
      throw new SpecweaveInstallFailure(
        "failed",
        "npm installed the SpecWeave package but not its specweave command.",
      );
    await host.remove(prefix);
    await host.mkdirp(path.dirname(prefix));
    await host.rename(staging, prefix);
  } finally {
    await host.remove(staging);
  }
  log(`SpecWeave ${SPECWEAVE_VERSION} is in ${prefix}`);
  return {
    handedOff: false,
    detail: `SpecWeave ${SPECWEAVE_VERSION} is installed for SpecWithCode.`,
    pathDirs: [managedSpecweaveDir(ctx.home, host.platform)],
  };
}
