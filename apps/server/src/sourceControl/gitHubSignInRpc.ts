// @effect-diagnostics nodeBuiltinImport:off - gh runs as a child process of this server.
/**
 * `gitHubSignIn.*`: another device asks this machine's server to sign its gh
 * in. One flow per server, shared by every client and connection, so a
 * reconnect or a second window sees the same code instead of starting over.
 *
 * `gitHubCredential.*`: this machine's GitHub access as SpecWithCode sees it,
 * removing a sign-in copied here, and copying this machine's sign-in to a
 * fleet machine (GitHubCredentialCopy.ts). No result or error holds a token.
 */
import * as NodeChildProcess from "node:child_process";

import {
  GITHUB_CREDENTIAL_RPC_METHODS,
  GITHUB_SIGN_IN_RPC_METHODS,
  REDACTED_SECRET_MARKER,
  GitHubCredentialError,
  type GitHubCredentialCopyInput,
  GitHubSignInError,
  WsGitHubSignInRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { fleetRequest } from "../fleet/fleetTransport.ts";
import { gitHubReadiness, runGhAuthStatus } from "../fleet/MachineReadiness.ts";
import * as ServerSettings from "../serverSettings.ts";
import { readBoundedJson } from "../studioFleet.ts";
import {
  copyCredential,
  GITHUB_CREDENTIAL_PATH,
  GitHubCredentialCopyFailure,
  inspectGitHubToken,
  previewCopy,
  removeCopiedTokenPatch,
  REPLACED_TOKEN_SECRET,
  type CopySourceDeps,
} from "./GitHubCredentialCopy.ts";
import {
  copiedNote,
  GITHUB_HOST,
  makeNodeGitHubCredentialProbe,
  readGitHubCredentialState,
} from "./gitHubCredentialState.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeGitHubSignIn, type GitHubSignIn } from "./GitHubSignIn.ts";

function ghLoginHelp(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "gh",
      ["auth", "login", "--help"],
      { env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, timeout: 10_000 },
      (error, stdout, stderr) =>
        resolve(error && !stdout ? null : `${String(stdout)}\n${String(stderr)}`),
    );
  });
}

function ghToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "gh",
      ["auth", "token", "--hostname", GITHUB_HOST],
      // Never let gh print the token into a debug log.
      { env: { ...env, GH_DEBUG: "", GH_PROMPT_DISABLED: "1" }, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

let shared: GitHubSignIn | undefined;

const credentialError = (reason: string) => new GitHubCredentialError({ reason });

const layerHandlers = WsGitHubSignInRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const pty = yield* PtyAdapter.PtyAdapter;
    const env = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;
    const signIn = (shared ??= makeGitHubSignIn({
      spawn: (input) => Effect.runPromise(pty.spawn(input)),
      authStatus: () => gitHubReadiness(() => runGhAuthStatus(env)),
      loginHelp: () => ghLoginHelp(env),
      env,
      platform,
    }));
    const settings = yield* ServerSettings.ServerSettingsService;
    const targets = yield* FleetTargets.FleetTargets;
    const fetcher = yield* FetchHttpClient.Fetch;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const github = settings.getSettings.pipe(
      Effect.map((current) => current.github),
      Effect.mapError(() => credentialError("This machine's settings could not be read.")),
    );
    const state = github.pipe(
      Effect.flatMap((current) =>
        Effect.promise(async () => {
          const read = await readGitHubCredentialState({
            probe: makeNodeGitHubCredentialProbe(env),
            env,
            settings: current,
          });
          // A token saved by hand carries no note; GitHub names its account.
          const saved = current.tokens[GITHUB_HOST]?.trim();
          if (read.inUse?.source !== "saved" || read.inUse.login !== null) return read;
          if (!saved || saved === REDACTED_SECRET_MARKER) return read;
          const facts = await inspectGitHubToken(fetcher, saved);
          return facts ? { ...read, inUse: { ...read.inUse, login: facts.login } } : read;
        }),
      ),
    );
    const sourceDeps = Effect.gen(function* () {
      const descriptor = yield* environment.getDescriptor;
      const current = yield* github;
      const link = FleetTargets.linkOf(targets);
      const hostEnabled = current.hosts[GITHUB_HOST]?.enabled !== false;
      const saved = current.tokens[GITHUB_HOST]?.trim() || null;
      return {
        hostEnabled,
        // An unreadable secret leaves only the redaction marker, which is never sent.
        savedToken: async () => (hostEnabled && saved !== REDACTED_SECRET_MARKER ? saved : null),
        ghToken: () => (hostEnabled ? ghToken(env) : Promise.resolve(null)),
        fetch: fetcher,
        machines: () => Effect.runPromise(targets.load).then((config) => config?.machines ?? []),
        send: async (target, body) => {
          const { response } = await fleetRequest(link, target, GITHUB_CREDENTIAL_PATH, {
            method: "POST",
            token: target.managementToken,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            timeoutMs: 15_000,
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return { status: response.status, copiedAt: null };
          }
          const reply = (await readBoundedJson(response, 4096)) as { copiedAt?: unknown };
          return {
            status: response.status,
            copiedAt: typeof reply?.copiedAt === "string" ? reply.copiedAt.slice(0, 64) : null,
          };
        },
        sourceLabel: descriptor.label,
      } satisfies CopySourceDeps;
    });
    // A failure's text is written for people; any other cause is dropped, so no token leaks.
    const runCopy = <A>(run: (deps: CopySourceDeps) => Promise<A>) =>
      sourceDeps.pipe(
        Effect.flatMap((deps) =>
          Effect.tryPromise({
            try: () => run(deps),
            catch: (cause) =>
              credentialError(
                cause instanceof GitHubCredentialCopyFailure
                  ? cause.message
                  : "The GitHub sign-in could not be copied.",
              ),
          }),
        ),
      );
    return {
      [GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialState]: () => state,
      [GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialRemoveCopied]: () =>
        github.pipe(
          Effect.flatMap((current) =>
            Effect.gen(function* () {
              // The token saved by hand that the copy replaced comes back.
              const note = current.copiedTokens[GITHUB_HOST];
              const previous =
                note?.replacedSaved === true && copiedNote(current) !== undefined
                  ? Option.getOrUndefined(yield* secrets.get(REPLACED_TOKEN_SECRET))
                  : undefined;
              const patch = removeCopiedTokenPatch(
                current,
                previous === undefined ? null : new TextDecoder().decode(previous),
              );
              if (patch === null) return;
              yield* settings.updateSettings(patch);
              if (note?.replacedSaved === true) yield* secrets.remove(REPLACED_TOKEN_SECRET);
            }).pipe(
              Effect.mapError(() => credentialError("The copied sign-in could not be removed.")),
            ),
          ),
          Effect.andThen(state),
        ),
      [GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialCopyPreview]: (
        input: GitHubCredentialCopyInput,
      ) => runCopy((deps) => previewCopy(deps, input.targetEnvironmentId)),
      [GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialCopy]: (input: GitHubCredentialCopyInput) =>
        runCopy((deps) =>
          copyCredential(deps, input.targetEnvironmentId, {
            replaceSaved: input.replaceSaved === true,
          }),
        ),
      [GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInStart]: () =>
        Effect.tryPromise({
          try: () => signIn.start(),
          catch: () => new GitHubSignInError({ reason: "The GitHub sign-in could not start." }),
        }),
      [GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInStatus]: () => Effect.sync(() => signIn.status()),
      [GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInCancel]: (input: {
        readonly flowId?: string | undefined;
      }) => Effect.sync(() => signIn.cancel(input.flowId)),
    };
  }),
);

export const layerRpcHandlers = layerHandlers.pipe(Layer.provide(FleetTargets.layer));
