// @effect-diagnostics nodeBuiltinImport:off - Path arithmetic on the design root.
/**
 * Connects the import service to the design service: owner roots come from
 * `DesignService` (which decides what a caller may use) and files go through
 * the design store. Reads and scans use `findOwnerRoot`, which never creates
 * a folder; only a confirmed write uses `ownerRoot`.
 */
import * as NodePath from "node:path";

import {
  type DesignError,
  type DesignOwner,
  type DesignOwnerInput,
  PROJECT_DESIGN_DIR,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DesignService, PLAYGROUND_DESIGN_DIR } from "../DesignService.ts";
import * as Store from "../DesignStore.ts";
import {
  type DesignSystemCaller,
  DesignSystemFiles,
  DesignSystemProposals,
  DesignSystemRoots,
  DesignSystemService,
  layer as layerDesignSystemService,
} from "./DesignSystemService.ts";

type FoundRoot = { readonly owner: DesignOwner; readonly root: string };

export interface OwnerRootSource {
  readonly findOwnerRoot: (
    caller: DesignSystemCaller,
    owner: DesignOwnerInput,
  ) => Effect.Effect<FoundRoot, DesignError>;
  readonly ownerRoot: (
    caller: DesignSystemCaller,
    owner: DesignOwnerInput,
  ) => Effect.Effect<FoundRoot, DesignError>;
  /** The Playground's folder below the app's state directory, for references. */
  readonly playgroundDir: string;
}

/** A project's design root is `<checkout>/.specweave/design`; the Playground has no checkout. */
export const rootsFrom = (source: OwnerRootSource) => {
  const describe = ({ owner, root }: FoundRoot) => {
    const relative = owner.kind === "project" ? PROJECT_DESIGN_DIR : source.playgroundDir;
    const depth = relative.split("/").length;
    return {
      owner,
      designRoot: root,
      projectRoot:
        owner.kind === "project"
          ? NodePath.resolve(root, ...Array.from({ length: depth }, () => ".."))
          : null,
      refPrefix: `${relative}/${Store.DESIGN_SYSTEMS_DIR}/`,
    };
  };
  return DesignSystemRoots.of({
    resolve: (caller, owner) => source.findOwnerRoot(caller, owner).pipe(Effect.map(describe)),
    resolveForWrite: (caller, owner) => source.ownerRoot(caller, owner).pipe(Effect.map(describe)),
  });
};

export const layerRoots = Layer.effect(
  DesignSystemRoots,
  Effect.gen(function* () {
    const designs = yield* DesignService;
    return rootsFrom({
      findOwnerRoot: designs.findOwnerRoot,
      ownerRoot: designs.ownerRoot,
      playgroundDir: PLAYGROUND_DESIGN_DIR,
    });
  }),
);

export const layerFiles = Layer.succeed(
  DesignSystemFiles,
  DesignSystemFiles.of({
    listDesignSystems: Store.listDesignSystems,
    readDesignSystem: Store.readDesignSystem,
    writeDesignSystem: Store.writeDesignSystem,
  }),
);

/**
 * The import service over a design service. Needs `DesignService` and the
 * server's one `DesignSystemProposals`.
 */
export const layer: Layer.Layer<DesignSystemService, never, DesignService | DesignSystemProposals> =
  layerDesignSystemService.pipe(Layer.provide(Layer.merge(layerRoots, layerFiles)));
