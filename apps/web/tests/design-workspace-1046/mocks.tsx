/**
 * Simulated data, permission and capability modules for the 1046 fixture.
 * Queries and commands run against an in-memory store seeded from
 * systemData.ts; token edits go through the shared reducer the server uses.
 * Every command is recorded in `window.__fixture.calls`.
 */
import {
  DESIGN_SYSTEM_FILES_MAX_BYTES,
  DESIGN_SYSTEM_FILES_MAX_COUNT,
  type DesignOwnerInput,
  type DesignSummary,
  type DesignSystem,
  type DesignSystemFile,
  type DesignSystemId,
  type DesignSystemOperation,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import {
  applyDesignSystemOperations,
  newDesignSystem,
} from "@specweave-studio/shared/designSystemOps";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useEnvironmentQuery as useRealEnvironmentQuery } from "~/state/query";
import { serverEnvironment as realServerEnvironment } from "~/state/server";

import {
  DESIGNS,
  EMPTY_SYSTEM,
  ENVIRONMENT,
  PROJECT,
  PROJECTS,
  SCRATCH_ROOT,
  SOURCES,
  STORED,
  SYSTEM,
  THREADS,
  USAGE,
} from "./systemData";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SystemEntry {
  readonly owner: DesignOwnerInput;
  readonly system: DesignSystem;
}
interface StoredEntry {
  readonly file: DesignSystemFile;
  readonly text?: string | undefined;
  readonly base64?: string | undefined;
}
interface Call {
  /** The atom that ran (`design.systemApply`). */
  readonly label: string;
  /** The RPC it stands for (`designSystem.apply`). */
  readonly rpc: string;
  readonly environmentId: unknown;
  readonly input: unknown;
}

const HARBOR: DesignOwnerInput = { kind: "project", projectId: PROJECT };
const store = {
  version: 0,
  nextId: 1,
  systems: new Map<string, SystemEntry>([
    [SYSTEM.id, { owner: HARBOR, system: SYSTEM }],
    [EMPTY_SYSTEM.id, { owner: HARBOR, system: EMPTY_SYSTEM }],
  ]),
  stored: new Map<string, StoredEntry[]>([
    [SYSTEM.id, [...STORED]],
    [EMPTY_SYSTEM.id, []],
  ]),
  designs: [...DESIGNS] as DesignSummary[],
};

export const fixture = {
  calls: [] as Call[],
  /** Files read through `designSystem.fileRead`, as `origin:path`. */
  reads: [] as string[],
  store,
};

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const version = () => store.version;
function changed() {
  store.version += 1;
  for (const listener of listeners) listener();
}

/** The designs the board lists; a move changes them. */
export function useFixtureDesigns(): readonly DesignSummary[] {
  useSyncExternalStore(subscribe, version);
  return useMemo(() => [...store.designs], [store.version]);
}

// ---------------------------------------------------------------------------
// Atoms: `design.systemGet(key)` is a query, `design.systemApply` a command
// ---------------------------------------------------------------------------

const FIXTURE = Symbol.for("design-workspace-1046");
interface FixtureAtom {
  readonly [FIXTURE]: true;
  readonly query: string;
  readonly key: { readonly environmentId?: EnvironmentId; readonly input?: unknown };
}

function namespace(prefix: string): Record<string, unknown> {
  const cache = new Map<string, unknown>();
  return new Proxy({} as Record<string, unknown>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      let atom = cache.get(name);
      if (atom === undefined) {
        const label = `${prefix}.${name}`;
        atom = Object.assign(
          (key: FixtureAtom["key"]): FixtureAtom => ({ [FIXTURE]: true, query: label, key }),
          { label, [FIXTURE]: true },
        );
        cache.set(name, atom);
      }
      return atom;
    },
  });
}

export const design = namespace("design");
export const designSystemImport = namespace("designSystemImport");

const isFixtureAtom = (atom: unknown): atom is FixtureAtom =>
  atom !== null && typeof atom === "object" && (atom as FixtureAtom)[FIXTURE] === true;

/** `design.systemApply` → `designSystem.apply`; `design.move` → `design.move`. */
function rpcName(label: string): string {
  const [prefix, name = ""] = label.split(".");
  const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
  if (prefix === "design" && name.startsWith("system"))
    return `designSystem.${lower(name.slice(6))}`;
  if (prefix === "designSystemImport") return `designSystem.${name}`;
  return label;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error };
const ok = (value: unknown): Outcome => ({ ok: true, value });
const fail = (message: string): Outcome => ({ ok: false, error: new Error(message) });

const projectTitle = (projectId: string) =>
  PROJECTS.find((project) => project.id === projectId)?.title ?? "Project";

function ownerRef(owner: DesignOwnerInput) {
  return owner.kind === "project"
    ? { kind: "project" as const, environmentId: ENVIRONMENT, projectId: owner.projectId }
    : { kind: "playground" as const, environmentId: ENVIRONMENT };
}

function systemRef(entry: SystemEntry) {
  return {
    owner: ownerRef(entry.owner),
    systemId: entry.system.id,
    path: `.specweave/design/systems/${entry.system.id}`,
  };
}

function systemSummary(entry: SystemEntry) {
  return {
    ref: systemRef(entry),
    name: entry.system.name,
    revision: entry.system.revision,
    updatedAt: entry.system.updatedAt,
    tokenCount: entry.system.tokens.length,
    componentCount: entry.system.components.length,
    sources: entry.system.sources,
    ownerLabel: entry.owner.kind === "project" ? projectTitle(entry.owner.projectId) : "Playground",
  };
}

const TEXT_EXTENSIONS = /\.(md|markdown|txt|json|css|svg|html|ts|tsx|js)$/i;

function sourcesOf(systemId: string) {
  return systemId === SYSTEM.id ? SOURCES : [];
}

function filesResult(systemId: string) {
  const stored = store.stored.get(systemId) ?? [];
  return {
    files: [
      ...stored.map((entry) => entry.file),
      ...sourcesOf(systemId).map((entry) => entry.file),
    ],
    usedBytes: stored.reduce((sum, entry) => sum + entry.file.bytes, 0),
    limitBytes: DESIGN_SYSTEM_FILES_MAX_BYTES,
    limitFiles: DESIGN_SYSTEM_FILES_MAX_COUNT,
  };
}

function readFile(input: { systemId: string; origin: string; path: string }): Outcome {
  const entry =
    input.origin === "source"
      ? sourcesOf(input.systemId).find((candidate) => candidate.file.path === input.path)
      : store.stored.get(input.systemId)?.find((candidate) => candidate.file.path === input.path);
  if (entry === undefined) return fail(`${input.path} is not in this design system.`);
  fixture.reads.push(`${input.origin}:${input.path}`);
  const { text, base64 } = entry as StoredEntry;
  if (TEXT_EXTENSIONS.test(input.path))
    return ok({ file: entry.file, encoding: "utf8", data: text ?? atob(base64 ?? "") });
  return ok({
    file: entry.file,
    encoding: "base64",
    data: base64 ?? btoa(text ?? ""),
  });
}

function runQuery(label: string, input: any): Outcome {
  switch (label) {
    case "design.systemGet": {
      const entry = store.systems.get(input.systemId);
      return entry === undefined
        ? fail("Design system not found")
        : ok({ ref: systemRef(entry), system: entry.system });
    }
    case "design.systemList": {
      const filter = input.filter as { kind: string; projectId?: string };
      const systems = [...store.systems.values()]
        .filter((entry) =>
          filter.kind === "all"
            ? true
            : filter.kind === "playground"
              ? entry.owner.kind === "playground"
              : entry.owner.kind === "project" && entry.owner.projectId === filter.projectId,
        )
        .map(systemSummary);
      return ok({ systems, problems: [] });
    }
    case "design.systemUsage":
      return ok({ designs: USAGE[input.systemId] ?? 0 });
    case "design.systemFiles":
      return store.systems.has(input.systemId)
        ? ok(filesResult(input.systemId))
        : fail("Design system not found");
    case "design.systemFileRead":
      return readFile(input);
    case "design.list":
      return ok({ designs: store.designs, problems: [] });
    default:
      return ok(null);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const now = () =>
  new Date(Date.parse("2026-10-24T09:00:00.000Z") + store.version * 1000).toISOString();

function saveSystem(entry: SystemEntry, system: DesignSystem): Outcome {
  const next = { owner: entry.owner, system };
  store.systems.set(system.id, next);
  changed();
  return ok({ ref: systemRef(next), system });
}

function mimeOf(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    md: "text/markdown",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    woff2: "font/woff2",
    css: "text/css",
    json: "application/json",
  };
  return types[extension] ?? "application/octet-stream";
}

function runCommand(label: string, input: any): Outcome {
  const entry: SystemEntry | undefined =
    input && typeof input.systemId === "string" ? store.systems.get(input.systemId) : undefined;
  switch (label) {
    case "design.systemApply": {
      if (entry === undefined) return fail("Design system not found");
      if (input.expectedRevision !== entry.system.revision)
        return fail("This design system changed elsewhere.");
      const outcome = applyDesignSystemOperations(
        entry.system,
        input.operations as DesignSystemOperation[],
        { actor: { kind: "user" }, now: now() },
      );
      if (!outcome.ok) return fail(outcome.detail);
      return saveSystem(entry, { ...outcome.system, revision: entry.system.revision + 1 });
    }
    case "design.systemCreate": {
      const id = `s_fixture${String(store.nextId++).padStart(4, "0")}` as DesignSystemId;
      const system = newDesignSystem({
        id,
        name: input.name,
        description: input.description,
        modes: input.modes,
        now: now(),
      });
      store.stored.set(id, []);
      return saveSystem({ owner: input.owner, system }, system);
    }
    case "design.systemRename":
      if (entry === undefined) return fail("Design system not found");
      return saveSystem(entry, {
        ...entry.system,
        name: input.name,
        revision: entry.system.revision + 1,
      });
    case "design.systemCopy": {
      if (entry === undefined) return fail("Design system not found");
      const id = `s_copy${String(store.nextId++).padStart(4, "0")}` as DesignSystemId;
      store.stored.set(id, [...(store.stored.get(entry.system.id) ?? [])]);
      return saveSystem(
        { owner: input.to, system: entry.system },
        { ...entry.system, id, revision: 0 },
      );
    }
    case "design.systemDelete":
      if (entry === undefined) return fail("Design system not found");
      store.systems.delete(entry.system.id);
      changed();
      return ok({ deleted: true });
    case "design.systemFilePut": {
      const files = store.stored.get(input.systemId) ?? [];
      const file: DesignSystemFile = {
        path: input.path,
        origin: "stored",
        bytes: Math.floor((String(input.data).length * 3) / 4),
        mimeType: mimeOf(input.path),
        updatedAt: now(),
      };
      store.stored.set(input.systemId, [
        ...files.filter((candidate) => candidate.file.path !== input.path),
        { file, base64: input.data },
      ]);
      changed();
      return ok({ file });
    }
    case "design.systemFileDelete": {
      const files = store.stored.get(input.systemId) ?? [];
      store.stored.set(
        input.systemId,
        files.filter((candidate) => candidate.file.path !== input.path),
      );
      changed();
      return ok({ deleted: true });
    }
    case "design.systemFileMove": {
      const files = store.stored.get(input.systemId) ?? [];
      const moving = files.find((candidate) => candidate.file.path === input.from);
      if (moving === undefined) return fail(`${input.from} is not in this design system.`);
      const file = { ...moving.file, path: input.to };
      store.stored.set(input.systemId, [
        ...files.filter((candidate) => candidate !== moving),
        { ...moving, file },
      ]);
      changed();
      return ok({ file });
    }
    case "design.move": {
      const design = store.designs.find((summary) => summary.ref.designId === input.designId);
      if (design === undefined) return fail("Design not found");
      const ref = { ...design.ref, owner: ownerRef(input.to) };
      store.designs = store.designs.map((summary) =>
        summary === design
          ? {
              ...summary,
              ref,
              ownerLabel:
                input.to.kind === "project" ? projectTitle(input.to.projectId) : "Playground",
            }
          : summary,
      );
      changed();
      return ok({ ref });
    }
    case "designSystemImport.rescan":
      return ok({ status: "unchanged" });
    default:
      return ok({});
  }
}

// ---------------------------------------------------------------------------
// state/query, state/use-atom-command, client-runtime state/runtime
// ---------------------------------------------------------------------------

export function useEnvironmentQuery(atom: unknown) {
  const own = isFixtureAtom(atom) ? atom : null;
  // Queries of other modules (a report's save state) read as a machine that is not connected.
  const offline = useRealEnvironmentQuery(null);
  const current = useSyncExternalStore(subscribe, version);
  const key = own === null ? null : `${own.query}:${JSON.stringify(own.key)}`;
  // The store changes with every command, so a refresh has nothing to fetch.
  const refresh = useCallback(() => undefined, []);
  const view = useMemo(() => {
    if (own === null) return null;
    const outcome = runQuery(own.query, own.key.input);
    return {
      data: outcome.ok ? outcome.value : null,
      dataUpdatedAt: current,
      error: outcome.ok ? null : outcome.error.message,
      failure: outcome.ok ? null : outcome.error,
      isPending: false,
      isSuccess: outcome.ok,
      refresh,
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the key names the atom
  }, [key, current, refresh]);
  return view ?? offline;
}

const settle = (outcome: Outcome) =>
  outcome.ok ? AsyncResult.success(outcome.value) : AsyncResult.failure(Cause.fail(outcome.error));

export function useAtomCommand(command: unknown, _options?: unknown) {
  return useCallback(
    async (value: { environmentId?: unknown; input?: unknown }) => {
      const label = isFixtureCommand(command)
        ? command.label
        : String((command as { label?: unknown } | null)?.label ?? "command");
      const input = value && typeof value === "object" && "input" in value ? value.input : value;
      fixture.calls.push({
        label,
        rpc: rpcName(label),
        environmentId: value?.environmentId ?? null,
        input: JSON.parse(JSON.stringify(input ?? null)),
      });
      await Promise.resolve();
      return settle(runCommand(label, input));
    },
    [command],
  );
}

const isFixtureCommand = (command: unknown): command is { label: string } =>
  typeof command === "function" && (command as { [FIXTURE]?: boolean })[FIXTURE] === true;

/**
 * Fixture atoms read the store. Any other read (markdown settling a file link
 * on the host) answers as a machine that is not connected, so nothing asks
 * the page origin for an environment.
 */
export async function executeAtomQuery(
  _registry: unknown,
  atom: unknown,
  _options?: unknown,
  _reporter?: unknown,
) {
  await Promise.resolve();
  return settle(
    isFixtureAtom(atom)
      ? runQuery(atom.query, atom.key.input)
      : fail("This machine is not connected."),
  );
}

// ---------------------------------------------------------------------------
// state/session, state/entities, state/environments, hooks, env
// ---------------------------------------------------------------------------

export const useEnvironmentScope = (_environmentId: unknown, _scope?: unknown) => true;
export const readEnvironmentScope = (_environmentId: unknown, _scope?: unknown) => true;

const SERVER_CONFIGS = new Map([
  [
    ENVIRONMENT,
    {
      environment: {
        capabilities: { designSystemEditing: true, designMove: true, threadProjectMove: true },
      },
      scratchWorkspaceRoot: SCRATCH_ROOT,
    },
  ],
]);
export const useServerConfigs = () => SERVER_CONFIGS as never;
export const useProjects = () => PROJECTS as never;
export const useThreadShells = (_enabled?: boolean) => THREADS as never;
export const usePrimaryEnvironmentId = () => ENVIRONMENT;

const SCRATCH = {
  scratchWorkspaceRootFor: (environmentId: EnvironmentId | null) =>
    environmentId === ENVIRONMENT ? SCRATCH_ROOT : null,
  scratchEnvironmentId: () => ENVIRONMENT,
  openScratchProject: async () => undefined,
  startScratchThread: async () => undefined,
};
export const useScratchProject = () => SCRATCH;

export const isElectron = false;

// No machine is connected: project icons draw their fallback, markdown has no
// prepared connection or server config, and nothing asks the page origin for one.
const NOTHING = Atom.make<null>(null);
export const projectFaviconUrlAtom = (_input: unknown) => NOTHING;
export const usePreparedConnection = (_environmentId: unknown) => null;
export const useEnvironmentPresentation = (_environmentId: unknown) => ({
  isReady: true,
  presentation: null,
});
export const serverEnvironment = new Proxy(realServerEnvironment, {
  get: (target, name, receiver) =>
    name === "configValueAtom" ? () => NOTHING : Reflect.get(target, name, receiver),
});
