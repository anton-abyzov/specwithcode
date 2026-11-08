import * as DateTime from "effect/DateTime";
/** Execution-host-only checks. Skill declarations never run commands or external probes. */
import {
  evaluateWorkflow,
  WorkflowRequirements,
  type WorkflowDeclaration,
  type WorkflowCapabilityScope,
  type RuntimeToolInventory,
  type ServerProviderSkill,
  type CapabilityState,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import { parse } from "yaml";
import { SKILL_MENTION_PATTERN } from "@specweave-studio/shared/composerInlineTokens";
import {
  CommandResolutionCache,
  readEnvPath,
  resolveCommandPathForPlatform,
} from "@specweave-studio/shared/shell";

/** The PATH a provider runs with, read the way Windows env copies spell it too. */
export const workflowExecutionPathOf = (env: NodeJS.ProcessEnv): string => readEnvPath(env) ?? "";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function parseWorkflowDeclaration(contents: string): WorkflowDeclaration {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!match)
    return /^\uFEFF?---/.test(contents) && /\bspecwithcode\s*:/.test(contents)
      ? {
          state: "invalid",
          reason: "Workflow frontmatter is incomplete. Close its YAML block before invoking it.",
        }
      : { state: "undeclared" };
  try {
    const metadata = object(object(parse(match[1]!)).metadata);
    if (
      Object.hasOwn(metadata, "specwithcode") &&
      (metadata.specwithcode === null ||
        typeof metadata.specwithcode !== "object" ||
        Array.isArray(metadata.specwithcode))
    )
      return {
        state: "invalid",
        reason: "metadata.specwithcode must be an object containing requires.",
      };
    const extension = object(metadata.specwithcode);
    if (!Object.hasOwn(extension, "requires")) return { state: "undeclared" };
    const raw = extension.requires;
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["tools", "binaries", "platforms"].includes(key))
    )
      return {
        state: "invalid",
        reason: "Invalid workflow dependencies. Use only tools, binaries and platforms.",
      };
    const decoded = Schema.decodeUnknownOption(WorkflowRequirements)(raw);
    return Option.isSome(decoded)
      ? { state: "declared", requires: decoded.value }
      : {
          state: "invalid",
          reason:
            "Invalid workflow dependencies. Expected bounded tool ids, binary names and platform names.",
        };
  } catch {
    if (!/specwithcode/.test(match[1]!)) return { state: "undeclared" };
    return {
      state: "invalid",
      reason: "Skill frontmatter could not be parsed. Repair its YAML before invoking it.",
    };
  }
}

export const readWorkflowDeclaration = Effect.fn("workflow.readDeclaration")(function* (
  skillPath: string,
) {
  // Native command identifiers are not inspectable filesystem declarations.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(skillPath) && !/^[A-Za-z]:[\\/]/.test(skillPath))
    return { state: "undeclared" } satisfies WorkflowDeclaration;
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(skillPath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || info.value.size > 1_000_000n)
    return {
      state: "invalid",
      reason: "The skill file is missing, unreadable or too large. Rescan skills on this machine.",
    } satisfies WorkflowDeclaration;
  const contents = yield* fs.readFileString(skillPath).pipe(Effect.option);
  return Option.isSome(contents)
    ? parseWorkflowDeclaration(contents.value)
    : ({
        state: "invalid",
        reason: "The skill file could not be read on this machine.",
      } satisfies WorkflowDeclaration);
});

/** PATH lookup only. No binary is launched; relative/empty PATH entries resolve only against the execution workspace. */
export const checkWorkflow = Effect.fn("workflow.check")(function* (input: {
  skill: Pick<ServerProviderSkill, "path" | "enabled">;
  scope: WorkflowCapabilityScope;
  inventory?: RuntimeToolInventory | undefined;
  executionPath?: string | undefined;
  platform?: string | undefined;
  discoveredAt?: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const skillPath =
    path.isAbsolute(input.skill.path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input.skill.path)
      ? input.skill.path
      : path.resolve(input.scope.workspaceRoot, input.skill.path);
  const declaration = yield* readWorkflowDeclaration(skillPath);
  const platform = input.platform ?? process.platform;
  const binaries = new Map<string, CapabilityState>();
  const required = declaration.state === "declared" ? (declaration.requires.binaries ?? []) : [];
  if (required.length > 0 && input.executionPath === undefined)
    // No execution PATH reported: nothing on disk can establish presence or absence.
    for (const binary of required) binaries.set(binary, "unknown");
  else if (required.length > 0) {
    const delimiter = platform === "win32" ? ";" : ":";
    // Relative and empty entries resolve against the execution workspace, never the server's cwd.
    const dirs = (input.executionPath ?? "")
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
      .map((dir) =>
        path.isAbsolute(dir) ? dir : path.resolve(input.scope.workspaceRoot, dir || "."),
      );
    const env = { PATH: dirs.join(delimiter), PATHEXT: process.env.PATHEXT };
    // A fresh cache per check: this is the "last safe check", not a 30-second-old answer.
    const cache = new Map();
    for (const binary of required) {
      if (dirs.length > 128) {
        binaries.set(binary, "unknown");
        continue;
      }
      const found = yield* resolveCommandPathForPlatform(binary, {
        env,
        platform: platform as NodeJS.Platform,
      }).pipe(
        Effect.provideService(CommandResolutionCache, cache),
        Effect.as(true),
        Effect.catchTag("CommandResolutionError", () => Effect.succeed(false)),
      );
      if (found) {
        binaries.set(binary, "available");
        continue;
      }
      // Not resolvable. Tell a present but non-executable file, or an unreadable
      // directory, apart from a binary that is truly absent.
      let state: CapabilityState = "missing";
      for (const dir of platform === "win32" ? [] : dirs) {
        const stat = yield* fs.stat(path.join(dir, binary)).pipe(
          Effect.map(Option.some),
          Effect.catch((error) => {
            if (error.reason._tag !== "NotFound") state = "unknown";
            return Effect.succeed(Option.none());
          }),
        );
        if (Option.isSome(stat) && stat.value.type === "File") {
          state = "denied";
          break;
        }
      }
      binaries.set(binary, state);
    }
  }
  return evaluateWorkflow({
    scope: input.scope,
    declaration,
    enabled: input.skill.enabled,
    now,
    platform,
    binaries,
    inventory: input.inventory,
    discoveredAt: input.discoveredAt ?? DateTime.formatIso(DateTime.makeUnsafe(now)),
  });
});

export function hasWorkflowInvocationSyntax(text: string): boolean {
  return (
    new RegExp(SKILL_MENTION_PATTERN.source, SKILL_MENTION_PATTERN.flags).test(text) ||
    /^\/[A-Za-z0-9][A-Za-z0-9:_-]*(?=\s|$)/.test(text)
  );
}

export function explicitlyInvokedSkills(text: string, skills: ReadonlyArray<ServerProviderSkill>) {
  const names = new Set(
    [...text.matchAll(new RegExp(SKILL_MENTION_PATTERN.source, SKILL_MENTION_PATTERN.flags))].map(
      (match) => match[2],
    ),
  );
  const leading = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?=\s|$)/.exec(text);
  if (leading) names.add(leading[1]);
  return skills.filter((skill) => names.has(skill.name));
}

export const annotateWorkflowSkills = Effect.fn("workflow.annotateSkills")(function* (input: {
  skills: ReadonlyArray<ServerProviderSkill>;
  scope: WorkflowCapabilityScope;
  executionPath?: string | undefined;
}) {
  return yield* Effect.forEach(
    input.skills,
    (skill) =>
      checkWorkflow({ skill, scope: input.scope, executionPath: input.executionPath }).pipe(
        Effect.map((workflow) => ({ ...skill, workflow })),
      ),
    { concurrency: 8 },
  );
});

export const unknownToolInventory = (
  scope: WorkflowCapabilityScope,
  state: CapabilityState = "unsupported",
): Effect.Effect<RuntimeToolInventory> =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    scope,
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    complete: false,
    state,
    source:
      state === "unsupported"
        ? "Provider session introspection is unsupported"
        : state === "error"
          ? "Native tool inspection failed"
          : "No current native tool inventory was returned",
    tools: [],
    servers: [],
  }));

/** Drop every SDK field except bounded public ids/states. No error text, endpoints or account ids. */
export const codexToolInventory = (
  scope: WorkflowCapabilityScope,
  pages: ReadonlyArray<unknown>,
): Effect.Effect<RuntimeToolInventory> =>
  Effect.map(Clock.currentTimeMillis, (now) => codexToolInventoryAt(scope, pages, now));

function codexToolInventoryAt(
  scope: WorkflowCapabilityScope,
  pages: ReadonlyArray<unknown>,
  now: number,
): RuntimeToolInventory {
  const servers: RuntimeToolInventory["servers"][number][] = [];
  const tools: string[] = [];
  for (const page of pages)
    for (const raw of Array.isArray(object(page).data) ? (object(page).data as unknown[]) : []) {
      const server = object(raw);
      const name =
        typeof server.name === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(server.name)
          ? server.name
          : null;
      if (!name) continue;
      const state: CapabilityState =
        server.runtimeStatus === "authenticationRequired"
          ? "denied"
          : server.runtimeStatus === "disabled"
            ? "denied"
            : server.runtimeStatus === "failed" || server.toolsError
              ? "error"
              : server.runtimeStatus === "connected"
                ? "available"
                : "unknown";
      servers.push({ name, state });
      if (state === "available")
        for (const tool of Object.keys(object(server.tools)))
          if (/^[A-Za-z0-9_.:-]{1,160}$/.test(tool)) tools.push(`mcp__${name}__${tool}`);
    }
  return {
    scope,
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    complete: false,
    state: "available",
    source: "Codex thread MCP inventory (built-in and deferred tools may be omitted)",
    tools: [...new Set(tools)].slice(0, 4096),
    servers: servers.slice(0, 256),
  };
}
