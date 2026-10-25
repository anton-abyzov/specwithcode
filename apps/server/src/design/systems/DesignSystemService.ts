// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Wraps the plain-promise extractors and store.
/**
 * Design-system import: scan, propose, review, confirm, rescan, and the
 * Figma desktop status. Proposals are held in memory until confirmed or
 * discarded (they do not survive a restart) in one `DesignSystemProposals`
 * shared by the WebSocket handlers and the MCP tools, so a proposal an agent
 * makes is the one the user reviews. A confirmed review is the only thing
 * that writes, as a new revision through the design store.
 *
 * Roots come from `DesignSystemRoots` (the design service resolves an owner
 * to its folders), never from a client path. Writes go through
 * `DesignSystemFiles`, which has the design store's signatures.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";

import {
  DesignError,
  type DesignActor,
  type DesignOwner,
  type DesignOwnerFilter,
  type DesignOwnerInput,
  type DesignSystem,
  type DesignSystemConfirmInput,
  type DesignSystemGetResult,
  type DesignSystemLineage,
  DesignSystemProposal,
  type DesignSystemProposalSummary,
  type DesignSystemProposalsResult,
  type DesignSystemProposeInput,
  type DesignSystemRescanInput,
  type DesignSystemRescanResult,
  type DesignSystemScanInput,
  type DesignSystemScanResult,
  type DesignSystemSuggestionPreview,
  type DesignTokenType,
  type FigmaDesktopStatus,
  FIGMA_DESKTOP_MCP_URL,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  FigmaDesktopMcpClient,
  FigmaDesktopUnavailable,
  collectFigmaVariables,
  parseVariableDefinitions,
} from "../figma/FigmaDesktopMcpClient.ts";
import { assemble } from "./assemble.ts";
import {
  type Collected,
  type MutableToken,
  clip,
  compareText,
  modeName,
  safeId,
  sha256Hex,
} from "./common.ts";
import {
  type SourcedExtraction,
  applyReview,
  buildProposal,
  digestOf,
  extractFromCode,
  extractFromTokensFiles,
  listFolders,
  proposalCounts,
} from "./proposal.ts";
import {
  componentReadPlan,
  knownSystemByKey,
  knownSystemFor,
  preloadReader,
  readInsideRoot,
  scanCandidates,
} from "./scanCandidates.ts";
import { previewScan } from "./scanPreview.ts";

/** Open proposals per actor (the user, or one agent thread). */
export const MAX_PROPOSALS_PER_ACTOR = 20;
/** Open proposals on this server; past it, new ones are refused, never others evicted. */
export const MAX_PROPOSALS = 200;
/** One proposal's size as JSON. */
export const MAX_PROPOSAL_BYTES = 8 * 1024 * 1024;
const encodeProposalJson = Schema.encodeSync(Schema.fromJsonString(DesignSystemProposal));

const actorKey = (actor: DesignActor) =>
  actor.kind === "agent" ? `agent:${actor.threadId}` : actor.kind;

/** Where an owner's files live. Resolved by the design service. */
export interface DesignOwnerRoots {
  readonly owner: DesignOwner;
  /** `<checkout>/.specweave/design` or the Playground's design folder. */
  readonly designRoot: string;
  /** The project checkout; null for the Playground, which has no code. */
  readonly projectRoot: string | null;
  /** Prefix of `DesignSystemRef.path` up to the system folder (`.specweave/design/systems/`). */
  readonly refPrefix: string;
}

/**
 * Who is asking, in the design service's terms: the user here (no scope), or
 * an agent thread limited to its own project's designs (`scope`).
 */
export interface DesignSystemCaller {
  readonly actor: DesignActor;
  readonly audience: "owner" | "members" | "agents";
  readonly scope?: DesignOwnerInput | undefined;
}

export const userCaller: DesignSystemCaller = { actor: { kind: "user" }, audience: "owner" };

export class DesignSystemRoots extends Context.Service<
  DesignSystemRoots,
  {
    /**
     * Fails with `forbidden` when the caller may not use this owner. Never
     * creates a folder: scans and proposals leave the checkout as it was.
     */
    readonly resolve: (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
    ) => Effect.Effect<DesignOwnerRoots, DesignError>;
    /** The same for a confirmed write; creates the design folder when missing. */
    readonly resolveForWrite: (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
    ) => Effect.Effect<DesignOwnerRoots, DesignError>;
  }
>()("specweave-studio/design/systems/DesignSystemService/DesignSystemRoots") {}

/** The design store's design-system API (DesignStore.ts). Failures carry a `DesignError` code. */
export class DesignSystemFiles extends Context.Service<
  DesignSystemFiles,
  {
    readonly listDesignSystems: (root: string) => Promise<{
      systems: ReadonlyArray<DesignSystem>;
      problems: ReadonlyArray<{ id: string; detail: string }>;
    }>;
    readonly readDesignSystem: (
      root: string,
      systemId: string,
      revision?: number,
    ) => Promise<DesignSystem>;
    readonly writeDesignSystem: (
      root: string,
      system: DesignSystem,
      options: { expectedRevision: number | null; actor: DesignActor },
    ) => Promise<DesignSystem>;
  }
>()("specweave-studio/design/systems/DesignSystemService/DesignSystemFiles") {}

export interface DescribedSystem {
  readonly name: string;
  readonly description?: string;
  readonly modes?: ReadonlyArray<string>;
  readonly tokens: ReadonlyArray<{
    readonly name: string;
    readonly type?: DesignTokenType;
    readonly group?: string;
    readonly description?: string;
    /** Value per mode id; a plain string applies to the first mode. */
    readonly value: string | Readonly<Record<string, string>>;
  }>;
  readonly targetSystemId?: string;
}

/** Open proposals, newest last; one instance per server. */
export class DesignSystemProposals extends Context.Service<
  DesignSystemProposals,
  Map<string, DesignSystemProposal>
>()("specweave-studio/design/systems/DesignSystemService/DesignSystemProposals") {
  static readonly layer = Layer.sync(DesignSystemProposals, () => new Map());
}

export class DesignSystemService extends Context.Service<
  DesignSystemService,
  {
    readonly scan: (
      caller: DesignSystemCaller,
      input: DesignSystemScanInput,
    ) => Effect.Effect<DesignSystemScanResult, DesignError>;
    readonly propose: (
      caller: DesignSystemCaller,
      input: DesignSystemProposeInput,
    ) => Effect.Effect<DesignSystemProposal, DesignError>;
    readonly proposeDescribed: (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
      described: DescribedSystem,
    ) => Effect.Effect<DesignSystemProposal, DesignError>;
    readonly proposals: (
      caller: DesignSystemCaller,
      filter: DesignOwnerFilter,
    ) => Effect.Effect<DesignSystemProposalsResult, DesignError>;
    readonly getProposal: (
      caller: DesignSystemCaller,
      proposalId: string,
    ) => Effect.Effect<DesignSystemProposal, DesignError>;
    /** Writes a reviewed proposal. Only the user confirms; agents get `forbidden`. */
    readonly confirm: (
      caller: DesignSystemCaller,
      input: DesignSystemConfirmInput,
    ) => Effect.Effect<DesignSystemGetResult, DesignError>;
    readonly discard: (
      caller: DesignSystemCaller,
      proposalId: string,
    ) => Effect.Effect<{ discarded: boolean }, DesignError>;
    readonly rescan: (
      caller: DesignSystemCaller,
      input: DesignSystemRescanInput,
    ) => Effect.Effect<DesignSystemRescanResult, DesignError>;
    readonly figmaStatus: () => Effect.Effect<FigmaDesktopStatus, DesignError>;
  }
>()("specweave-studio/design/systems/DesignSystemService") {}

const failure = (code: DesignError["code"], detail: string, currentRevision?: number) =>
  new DesignError({ code, detail, ...(currentRevision !== undefined ? { currentRevision } : {}) });

/** Maps a store or file problem to a `DesignError`, keeping its code when it has one. */
const toDesignError = (error: unknown): DesignError => {
  if (Schema.is(DesignError)(error)) return error;
  const code = (error as { code?: unknown })?.code;
  const known = [
    "not_found",
    "not_on_this_machine",
    "invalid",
    "conflict",
    "forbidden",
    "too_large",
    "operation_failed",
  ] as const;
  const mapped = known.find((candidate) => candidate === code) ?? "operation_failed";
  const currentRevision = (error as { currentRevision?: unknown })?.currentRevision;
  return failure(
    mapped,
    error instanceof Error ? error.message : String(error),
    typeof currentRevision === "number" ? currentRevision : undefined,
  );
};

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toDesignError });

const sameOwner = (left: DesignOwnerInput, right: DesignOwnerInput) =>
  left.kind === right.kind &&
  (left.kind === "playground" || (right.kind === "project" && left.projectId === right.projectId));

/**
 * Drops the open proposals that would update `systemId` of `owner`, once that
 * system is deleted: confirming one would fail on the missing head. Returns how many.
 */
export const discardProposalsForSystem = (
  proposals: Map<string, DesignSystemProposal>,
  owner: DesignOwnerInput,
  systemId: string,
): number => {
  let discarded = 0;
  for (const [id, proposal] of proposals) {
    if (proposal.target?.systemId !== systemId || !sameOwner(proposal.owner, owner)) continue;
    proposals.delete(id);
    discarded += 1;
  }
  return discarded;
};

export interface DesignSystemServiceOptions {
  readonly figmaEndpoint?: string;
  readonly now?: () => string;
}

export const makeDesignSystemService = (options: DesignSystemServiceOptions = {}) =>
  Effect.gen(function* () {
    const roots = yield* DesignSystemRoots;
    const files = yield* DesignSystemFiles;
    const proposals = yield* DesignSystemProposals;
    const now = options.now ?? (() => new Date().toISOString());
    const figma = () => new FigmaDesktopMcpClient(options.figmaEndpoint ?? FIGMA_DESKTOP_MCP_URL);

    /**
     * Keeps a proposal for review. An actor over its quota loses its own
     * oldest proposal; another actor's pending proposal is never evicted, so
     * an agent cannot push the user's reviews out. A proposal that reuses an
     * open one's id replaces it.
     */
    const remember = (proposal: DesignSystemProposal) =>
      Effect.gen(function* () {
        if (encodeProposalJson(proposal).length > MAX_PROPOSAL_BYTES) {
          return yield* failure(
            "too_large",
            "This proposal is too large to review. Propose fewer files or tokens at a time.",
          );
        }
        if (proposals.delete(proposal.id)) {
          proposals.set(proposal.id, proposal);
          return proposal;
        }
        const key = actorKey(proposal.createdBy);
        const own = [...proposals.values()].filter((open) => actorKey(open.createdBy) === key);
        if (own.length >= MAX_PROPOSALS_PER_ACTOR) proposals.delete(own[0]!.id);
        else if (proposals.size >= MAX_PROPOSALS) {
          return yield* failure(
            "invalid",
            "Too many design-system proposals are waiting for review. Confirm or discard some in Settings > Design systems.",
          );
        }
        proposals.set(proposal.id, proposal);
        return proposal;
      });

    /** Checked here as well as by the design service: an agent names only its own owner. */
    const inScope = (caller: DesignSystemCaller, owner: DesignOwnerInput) =>
      caller.scope === undefined || sameOwner(caller.scope, owner)
        ? Effect.void
        : Effect.fail(
            failure("forbidden", "This thread can only use its own project's design systems."),
          );
    const resolve = (caller: DesignSystemCaller, owner: DesignOwnerInput) =>
      Effect.andThen(inScope(caller, owner), roots.resolve(caller, owner));
    const resolveForWrite = (caller: DesignSystemCaller, owner: DesignOwnerInput) =>
      Effect.andThen(inScope(caller, owner), roots.resolveForWrite(caller, owner));

    const projectRoot = (resolved: DesignOwnerRoots) =>
      resolved.projectRoot === null
        ? Effect.fail(
            failure(
              "invalid",
              "The Playground has no project code to read. Import a tokens file instead.",
            ),
          )
        : attempt(() => NodeFS.realpath(resolved.projectRoot!));

    /** A new id from the name, unique among the owner's systems and open proposals. */
    const newSystemId = (resolved: DesignOwnerRoots, owner: DesignOwnerInput, name: string) =>
      attempt(async () => {
        const existing = await files
          .listDesignSystems(resolved.designRoot)
          .catch(() => ({ systems: [], problems: [] }));
        const pending = [...proposals.values()].filter(
          (proposal) => proposal.target === null && sameOwner(proposal.owner, owner),
        );
        const taken = new Set([
          ...existing.systems.map((system) => system.id),
          ...pending.map((proposal) => proposal.system.id),
        ]);
        const base = safeId(name, "design-system").slice(0, 70);
        let id = base;
        for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`;
        return id;
      });

    /**
     * The owner's own copy of an upstream system (by its usual id, then by
     * name), or null: lineage never points at a system the owner does not hold.
     */
    const findUpstream = (
      resolved: DesignOwnerRoots,
      upstream: { readonly systemId: string; readonly name: string },
    ) =>
      attempt(async (): Promise<DesignSystemLineage | null> => {
        const { systems } = await files
          .listDesignSystems(resolved.designRoot)
          .catch(() => ({ systems: [] as ReadonlyArray<DesignSystem> }));
        const name = upstream.name.trim().toLowerCase();
        const match =
          systems.find((system) => system.id === upstream.systemId) ??
          systems
            .filter((system) => system.name.trim().toLowerCase() === name)
            .sort((left, right) => compareText(left.id, right.id))[0];
        return match ? { owner: resolved.owner, systemId: match.id } : null;
      });

    const finish = (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
      origin: DesignSystemProposal["origin"],
      sourced: SourcedExtraction,
      request: {
        name?: string;
        targetSystemId?: string;
        description?: string;
        derivedFrom?: DesignSystemLineage;
        derivedFromLabel?: string;
      },
    ) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(caller, owner);
        const previous = request.targetSystemId
          ? yield* attempt(() =>
              files.readDesignSystem(resolved.designRoot, request.targetSystemId!),
            )
          : null;
        const name = clip(request.name?.trim() || sourced.suggestedName || "Design system", 180);
        // The same actor proposing the same repository files again (each new design that
        // reuses a found system does) replaces its open proposal under the same id: designs
        // that point at it stay linked, and Settings lists it once. Only code proposals: a
        // described or Figma proposal shares its location across different content.
        const twin =
          origin === "code"
            ? [...proposals.values()].find(
                (open) =>
                  open.origin === "code" &&
                  actorKey(open.createdBy) === actorKey(caller.actor) &&
                  sameOwner(open.owner, owner) &&
                  (open.target?.systemId ?? null) === (previous?.id ?? null) &&
                  open.system.name === name &&
                  sourceKey(open.system.sources) === sourceKey(sourced.sources),
              )
            : undefined;
        const systemId =
          previous?.id ?? twin?.system.id ?? (yield* newSystemId(resolved, owner, name));
        return yield* remember(
          buildProposal({
            id: twin?.id ?? NodeCrypto.randomUUID(),
            owner,
            origin,
            createdBy: caller.actor,
            now: now(),
            sourced,
            previous,
            systemId,
            name,
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.derivedFrom !== undefined ? { derivedFrom: request.derivedFrom } : {}),
            ...(request.derivedFromLabel !== undefined
              ? { derivedFromLabel: request.derivedFromLabel }
              : {}),
          }),
        );
      });

    const proposeFromCode = (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
      paths: ReadonlyArray<string>,
      request: { name?: string; targetSystemId?: string },
    ) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(caller, owner);
        const realRoot = yield* projectRoot(resolved);
        const sourced = yield* attempt(() => extractFromCode(realRoot, paths));
        if (sourced.sources.length === 0) {
          return yield* failure(
            "invalid",
            "None of the selected files could be read inside the project.",
          );
        }
        const known = knownSystemFor(paths);
        const upstream = known?.upstream ? yield* findUpstream(resolved, known.upstream) : null;
        return yield* finish(caller, owner, "code", sourced, {
          ...request,
          ...(request.name === undefined && known ? { name: known.name } : {}),
          ...(known?.upstream ? { derivedFromLabel: known.upstream.name } : {}),
          ...(upstream ? { derivedFrom: upstream } : {}),
          ...(known ? { description: known.description } : {}),
        });
      });

    const proposeFromFigma = (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
      nodeId: string | undefined,
      request: { name?: string; targetSystemId?: string },
    ) =>
      Effect.gen(function* () {
        yield* resolve(caller, owner);
        const read = yield* Effect.tryPromise({
          try: () => figma().readVariables(nodeId),
          catch: (error) =>
            failure(
              "operation_failed",
              error instanceof FigmaDesktopUnavailable && error.state === "off"
                ? FIGMA_OFF_DETAIL
                : (error as Error).message,
            ),
        });
        const pairs = parseVariableDefinitions(read.text, read.structured);
        if (pairs.length === 0) {
          return yield* failure(
            "invalid",
            "Figma returned no variables. Select a frame that uses variables in Figma and try again.",
          );
        }
        const collected = collectFigmaVariables(pairs, {
          ...(nodeId ? { nodeId } : {}),
          tool: read.tool,
          responseText: read.text,
        });
        const sourced: SourcedExtraction = {
          extraction: assemble([collected]),
          sources: [
            {
              kind: "figma-desktop",
              location: nodeId ?? "selection",
              sha256: sha256Hex(read.text),
            },
          ],
        };
        return yield* finish(caller, owner, "figma-desktop", sourced, request);
      });

    const proposeDescribed = (
      caller: DesignSystemCaller,
      owner: DesignOwnerInput,
      described: DescribedSystem,
    ) =>
      Effect.gen(function* () {
        const modeIds = (described.modes?.length ? described.modes : ["default"]).map((mode) =>
          safeId(mode, "default"),
        );
        const location = caller.actor.kind === "agent" ? `thread:${caller.actor.threadId}` : "user";
        const tokens: MutableToken[] = [];
        for (const token of described.tokens) {
          const values: MutableToken["values"] = {};
          const entries =
            typeof token.value === "string"
              ? [[modeIds[0]!, token.value] as const]
              : Object.entries(token.value);
          for (const [mode, raw] of entries) {
            values[safeId(mode, "default")] = {
              raw: clip(raw),
              resolved: null,
              provenance: {
                source: "agent",
                location: location.slice(0, 500),
                context: token.name.slice(0, 300),
                extractor: "agent@1",
              },
            };
          }
          tokens.push({
            name: token.name.replace(/^--/, "").slice(0, 200),
            type: token.type ?? "other",
            explicitType: token.type !== undefined,
            values,
            ...(token.group ? { group: clip(token.group, 120) } : {}),
            ...(token.description ? { description: clip(token.description) } : {}),
          });
        }
        const collected: Collected = {
          modes: [
            ...new Set([...modeIds, ...tokens.flatMap((token) => Object.keys(token.values))]),
          ].map((id) => ({ id, name: modeName(id) })),
          tokens: tokens.sort((left, right) => compareText(left.name, right.name)),
          components: [],
          findings: [],
        };
        const sourced: SourcedExtraction = {
          extraction: assemble([collected]),
          sources: [{ kind: "agent", location: location.slice(0, 500) }],
        };
        return yield* finish(caller, owner, "agent", sourced, {
          name: described.name,
          ...(described.targetSystemId ? { targetSystemId: described.targetSystemId } : {}),
          ...(described.description ? { description: clip(described.description, 4_000) } : {}),
        });
      });

    const visibleTo = (caller: DesignSystemCaller, proposal: DesignSystemProposal) =>
      caller.scope === undefined || sameOwner(caller.scope, proposal.owner);

    const getProposal = (caller: DesignSystemCaller, proposalId: string) => {
      const proposal = proposals.get(proposalId);
      return proposal && visibleTo(caller, proposal)
        ? Effect.succeed(proposal)
        : Effect.fail(
            failure(
              "not_found",
              "That proposal is gone. Proposals last until they are confirmed or discarded, or the app restarts.",
            ),
          );
    };

    /** Current hash of a source as extraction computed it, without parsing. */
    const currentHash = (realRoot: string, folders: Map<string, string[]>, location: string) =>
      attempt(async () => {
        if (folders.has(location) || /(?:^|\/)index\.tsx?$/.test(location)) {
          const isFolder = folders.has(location);
          const folder = isFolder
            ? location
            : location.slice(0, Math.max(0, location.lastIndexOf("/")));
          const plan = isFolder
            ? componentReadPlan(new Map([[location, folders.get(location) ?? []]]), location)
            : componentReadPlan(folders, folder);
          const reader = await preloadReader(realRoot, folders, plan);
          const read = plan.map((path) => reader.read(path)).filter((source) => source !== null);
          return read.length > 0 ? digestOf(read) : null;
        }
        return (await readInsideRoot(realRoot, location).catch(() => null))?.sha256 ?? null;
      });

    return DesignSystemService.of({
      scan: (caller, input) =>
        Effect.gen(function* () {
          const resolved = yield* resolve(caller, input.owner);
          const realRoot = yield* projectRoot(resolved);
          const result = yield* attempt(() => scanCandidates(realRoot));
          // In memory only: no proposal is kept and nothing is written.
          const previews =
            input.preview === true
              ? yield* attempt(() => previewScan(realRoot, result))
              : new Map<string, DesignSystemSuggestionPreview>();
          const suggestions = yield* Effect.forEach(result.suggestions, (scanned) => {
            const preview = previews.get(scanned.key);
            const suggestion = preview ? { ...scanned, preview } : scanned;
            const upstream = knownSystemByKey(suggestion.key)?.upstream;
            return upstream
              ? Effect.map(findUpstream(resolved, upstream), (derivedFrom) =>
                  derivedFrom ? { ...suggestion, derivedFrom } : suggestion,
                )
              : Effect.succeed(suggestion);
          });
          return { ...result, suggestions };
        }),
      propose: (caller, input) => {
        const { from } = input;
        const request = {
          ...(from.name !== undefined ? { name: from.name } : {}),
          ...(from.targetSystemId !== undefined ? { targetSystemId: from.targetSystemId } : {}),
        };
        switch (from.kind) {
          case "code":
            return proposeFromCode(caller, input.owner, from.paths, request);
          case "tokens-file":
            return Effect.gen(function* () {
              const sourced = extractFromTokensFiles(from.files);
              if (sourced.sources.length === 0) {
                return yield* failure(
                  "invalid",
                  "None of the files is a DTCG tokens file or a Figma variables export.",
                );
              }
              return yield* finish(caller, input.owner, "tokens-file", sourced, request);
            });
          case "figma-desktop":
            return proposeFromFigma(caller, input.owner, from.nodeId, request);
        }
      },
      proposeDescribed,
      proposals: (caller, filter) =>
        Effect.succeed({
          proposals: [...proposals.values()]
            .filter(
              (proposal) => visibleTo(caller, proposal) && matchesFilter(filter, proposal.owner),
            )
            .sort(
              (left, right) =>
                compareText(right.createdAt, left.createdAt) || compareText(left.id, right.id),
            )
            .map(proposalSummary),
        }),
      getProposal,
      confirm: (caller, input) =>
        Effect.gen(function* () {
          if (caller.actor.kind !== "user") {
            return yield* failure(
              "forbidden",
              "Only the user confirms a design-system import, in Settings > Design systems.",
            );
          }
          const proposal = yield* getProposal(caller, input.proposalId);
          const resolved = yield* resolveForWrite(caller, proposal.owner);
          const reviewed = applyReview(proposal, input);
          // The upstream may have gone since the proposal; never write a dangling lineage.
          const lineage = reviewed.derivedFrom;
          const held =
            lineage === undefined
              ? true
              : lineage.owner.environmentId === resolved.owner.environmentId &&
                sameOwner(lineage.owner, resolved.owner) &&
                (yield* attempt(() =>
                  files
                    .readDesignSystem(resolved.designRoot, lineage.systemId)
                    .then(() => true)
                    .catch(() => false),
                ));
          const { derivedFrom: _dropped, ...withoutLineage } = reviewed;
          const system: DesignSystem = held ? reviewed : withoutLineage;
          const written = yield* attempt(() =>
            files.writeDesignSystem(resolved.designRoot, system, {
              expectedRevision: proposal.target === null ? null : proposal.target.revision,
              actor: caller.actor,
            }),
          );
          proposals.delete(proposal.id);
          return {
            ref: {
              owner: resolved.owner,
              systemId: written.id,
              path: `${resolved.refPrefix}${written.id}/system.json`,
            },
            system: written,
          };
        }),
      discard: (caller, proposalId) =>
        Effect.gen(function* () {
          const proposal = proposals.get(proposalId);
          if (!proposal || !visibleTo(caller, proposal)) return { discarded: false };
          return { discarded: proposals.delete(proposalId) };
        }),
      rescan: (caller, input) =>
        Effect.gen(function* () {
          const resolved = yield* resolve(caller, input.owner);
          const system = yield* attempt(() =>
            files.readDesignSystem(resolved.designRoot, input.systemId),
          );
          const fileSources = system.sources.filter((source) => source.kind === "file");
          if (fileSources.length === 0 || fileSources.length !== system.sources.length) {
            return {
              status: "not-rescannable" as const,
              detail:
                "This system came from an export, Figma or a description. Import it again to update it.",
            };
          }
          const realRoot = yield* projectRoot(resolved);
          const folders = yield* attempt(() => listFolders(realRoot));
          const changed: string[] = [];
          const missing: string[] = [];
          for (const source of fileSources) {
            const hash = yield* currentHash(realRoot, folders, source.location);
            if (hash === null) missing.push(source.location);
            else if (hash !== source.sha256) changed.push(source.location);
          }
          if (changed.length === 0 && missing.length === 0)
            return { status: "unchanged" as const, checked: fileSources };
          const present = fileSources
            .map((source) => source.location)
            .filter((location) => !missing.includes(location));
          const proposal =
            present.length > 0
              ? yield* proposeFromCode(caller, input.owner, present, { targetSystemId: system.id })
              : yield* finish(
                  caller,
                  input.owner,
                  "code",
                  { extraction: assemble([]), sources: [] },
                  { targetSystemId: system.id },
                );
          return {
            status: "changed" as const,
            changed: changed.sort(compareText),
            missing: missing.sort(compareText),
            proposal,
          };
        }),
      figmaStatus: () => Effect.promise(() => figma().status()),
    });
  });

export const FIGMA_OFF_DETAIL =
  "Figma desktop's MCP server is off. In Figma, open Preferences and turn on Enable desktop MCP server, or import an exported variables file.";

/** The files (or other sources) a proposal reads, in a stable order. */
const sourceKey = (sources: ReadonlyArray<{ readonly kind: string; readonly location: string }>) =>
  sources
    .map((source) => `${source.kind}:${source.location}`)
    .sort(compareText)
    .join("\n");

export const proposalSummary = (proposal: DesignSystemProposal): DesignSystemProposalSummary => ({
  id: proposal.id,
  owner: proposal.owner,
  origin: proposal.origin,
  createdAt: proposal.createdAt,
  createdBy: proposal.createdBy,
  name: proposal.system.name,
  target: proposal.target,
  counts: proposalCounts(proposal),
});

const matchesFilter = (filter: DesignOwnerFilter, owner: DesignOwnerInput) => {
  switch (filter.kind) {
    case "all":
      return true;
    case "playground":
      return owner.kind === "playground";
    case "projects":
      return owner.kind === "project";
    case "project":
      return owner.kind === "project" && owner.projectId === filter.projectId;
  }
};

/** Needs `DesignSystemRoots`, `DesignSystemFiles` and the server's one `DesignSystemProposals`. */
export const layer = Layer.effect(DesignSystemService, makeDesignSystemService());
