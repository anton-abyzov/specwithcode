/**
 * A project's design systems above its designs: each with a few swatches and
 * its counts, opening the design system page, and "New design system" with
 * the project already chosen.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  DesignOwner,
  DesignOwnerInput,
  DesignSystemCreateInput,
  DesignSystemSummary,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";

import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { encodeSystemKey } from "../designKey";
import {
  NEW_SYSTEM_MODES,
  NewDesignSystemDialog,
  type NewSystemMode,
} from "../systems/NewDesignSystemDialog";
import { failureText, ownerOfSummary, swatchColor, systemKey } from "../systems/reviewModel";
import { useOwnerProjects } from "../systems/useOwnerProjects";
import { useSystemReviewFlow } from "../systems/useSystemReviewFlow";
import { plural } from "../systems/workspace/systemText";
import { withMissingFolders } from "./boardOwner";

const SWATCHES = 6;

/** "84 tokens · 23 components". */
export const stripCounts = (system: Pick<DesignSystemSummary, "tokenCount" | "componentCount">) =>
  `${plural(system.tokenCount, "token")} · ${plural(system.componentCount, "component")}`;

/**
 * The system's own folder, which no other system of the same owner shares. The
 * path names the system's file (`…/systems/<folder>/system.json`), so the folder
 * is the segment before the file name; the id names it when the path is short.
 */
export const systemFolder = (system: DesignSystemSummary) =>
  system.ref.path
    .split("/")
    .filter((part) => part.length > 0)
    .at(-2) ?? system.ref.systemId;

const folderLine = (system: DesignSystemSummary) => `Folder ${systemFolder(system)}`;

/**
 * For systems that share a name with another in the strip, the line that tells
 * them apart: the owner a copy came from, else the system's folder. Keyed by
 * {@link systemKey}; systems with a unique name get none.
 */
export function stripDistinctions(
  systems: readonly DesignSystemSummary[],
  ownerTitle: (owner: DesignOwner) => string | undefined,
): ReadonlyMap<string, string> {
  const byName = new Map<string, DesignSystemSummary[]>();
  for (const system of systems) {
    const name = system.name.trim().toLocaleLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), system]);
  }
  const lines = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const labelled = group.map((system) => {
      const from =
        system.copiedFrom === undefined ? undefined : ownerTitle(system.copiedFrom.owner);
      return { system, line: from === undefined ? folderLine(system) : `Copied from ${from}` };
    });
    for (const { system, line } of labelled) {
      const shared = labelled.filter((other) => other.line === line).length > 1;
      lines.set(systemKey(system), shared ? folderLine(system) : line);
    }
  }
  return lines;
}

const playgroundTitle = (owner: DesignOwner) =>
  owner.kind === "playground" ? "Playground" : undefined;

export interface ProjectSystemsStripViewProps {
  /** Null while the list loads. */
  readonly systems: readonly DesignSystemSummary[] | null;
  readonly canWrite: boolean;
  readonly onOpen: (system: DesignSystemSummary) => void;
  readonly onNew: (mode: NewSystemMode) => void;
  /** A system's swatches; omitted where colors are not read. */
  readonly renderSwatches?: (system: DesignSystemSummary) => ReactNode;
  /** An owner's title, naming where a same-named copy came from; Playground only when omitted. */
  readonly ownerTitle?: (owner: DesignOwner) => string | undefined;
}

export function ProjectSystemsStripView(props: ProjectSystemsStripViewProps) {
  const distinctions = stripDistinctions(props.systems ?? [], props.ownerTitle ?? playgroundTitle);
  return (
    <section
      aria-label="Design systems"
      className="flex flex-col gap-2.5"
      data-testid="project-systems-strip"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium text-foreground text-sm">Design systems</h2>
        {props.canWrite ? (
          <Menu>
            <MenuTrigger
              render={<Button variant="outline" size="xs" data-testid="strip-new-system" />}
            >
              <PlusIcon aria-hidden />
              New design system
              <ChevronDownIcon aria-hidden className="opacity-60" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-56">
              {NEW_SYSTEM_MODES.map(({ mode, label }) => (
                <MenuItem key={mode} data-mode={mode} onClick={() => props.onNew(mode)}>
                  {label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {props.systems === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          Loading design systems…
        </p>
      ) : props.systems.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No design system yet. Designs here use one for their colors, type and components.
        </p>
      ) : (
        <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
          {props.systems.map((system) => {
            const distinction = distinctions.get(systemKey(system));
            return (
              <li key={systemKey(system)} className="w-60 shrink-0 snap-start">
                <button
                  type="button"
                  className="flex h-full w-full flex-col gap-2.5 rounded-xl border border-border/70 bg-card p-3 text-left outline-none transition-colors duration-[120ms] hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  data-testid="strip-system"
                  onClick={() => props.onOpen(system)}
                >
                  <span className="flex h-5 items-center gap-1" aria-hidden>
                    {props.renderSwatches?.(system) ?? null}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium text-foreground text-sm">
                      {system.name}
                    </span>
                    {distinction !== undefined ? (
                      <span
                        className="truncate text-muted-foreground text-xs"
                        data-testid="strip-system-distinction"
                        title={system.ref.path}
                      >
                        {distinction}
                      </span>
                    ) : null}
                    <span className="truncate text-muted-foreground text-xs">
                      {stripCounts(system)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The first few color tokens of a system, in its first mode. */
export function SwatchRow({ colors }: { colors: readonly string[] }) {
  return (
    <>
      {colors.slice(0, SWATCHES).map((color, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- colors repeat
          key={index}
          className="size-5 rounded-full ring-1 ring-black/10 ring-inset dark:ring-white/12"
          style={{ backgroundColor: color }}
        />
      ))}
    </>
  );
}

function LoadedSwatches({
  environmentId,
  owner,
  summary,
}: {
  environmentId: EnvironmentId;
  owner: DesignOwnerInput;
  summary: DesignSystemSummary;
}) {
  const get = useEnvironmentQuery(
    design.systemGet({ environmentId, input: { owner, systemId: summary.ref.systemId } }),
  );
  const system = get.data?.system;
  if (system === undefined) return null;
  const first = system.modes[0]?.id ?? "default";
  const colors = system.tokens
    .filter((token) => token.type === "color")
    .map((token) => swatchColor(token.values[first] ?? Object.values(token.values)[0]))
    .filter((color): color is string => color !== null);
  return <SwatchRow colors={colors} />;
}

/** The strip wired to this machine; nothing where it is not connected. */
export function ProjectSystemsStrip({
  projectId,
  canWrite,
  missingFolders,
}: {
  projectId: ProjectId;
  canWrite: boolean;
  /** Projects whose folder is gone; the new-system pickers show them as not available. */
  missingFolders?: ReadonlySet<ProjectId>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return (
    <ConnectedStrip
      environmentId={environmentId}
      projectId={projectId}
      canWrite={canWrite}
      missingFolders={missingFolders ?? NO_PROJECTS}
    />
  );
}

const NO_PROJECTS: ReadonlySet<ProjectId> = new Set();

function ConnectedStrip({
  environmentId,
  projectId,
  canWrite,
  missingFolders,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  canWrite: boolean;
  missingFolders: ReadonlySet<ProjectId>;
}) {
  const router = useRouter();
  const ownerProjects = useOwnerProjects(environmentId);
  const projects = useMemo(
    () => withMissingFolders(ownerProjects, missingFolders),
    [missingFolders, ownerProjects],
  );
  const canCreate =
    useServerConfigs().get(environmentId)?.environment.capabilities.designSystemEditing === true;
  const createSystem = useAtomCommand(design.systemCreate, { reportFailure: false });
  const [mode, setMode] = useState<NewSystemMode | null>(null);
  const list = useEnvironmentQuery(
    design.systemList({ environmentId, input: { filter: { kind: "project", projectId } } }),
  );
  const open = (owner: DesignOwnerInput, systemId: DesignSystemSummary["ref"]["systemId"]) =>
    void router.navigate({
      to: "/design/systems/$systemKey",
      params: { systemKey: encodeSystemKey(owner, systemId) },
    });
  const review = useSystemReviewFlow({
    environmentId,
    projects,
    figmaWanted: mode !== null,
    onSaved: (system) => {
      list.refresh();
      open({ kind: "project", projectId }, system.id);
    },
  });
  const onCreate = async (input: DesignSystemCreateInput): Promise<string | null> => {
    const result = await createSystem({ environmentId, input });
    if (result._tag === "Failure")
      return failureText(squashAtomCommandFailure(result), "The design system was not created.");
    setMode(null);
    list.refresh();
    open(input.owner, result.value.system.id);
    return null;
  };
  return (
    <>
      <ProjectSystemsStripView
        systems={list.data?.systems ?? (list.error ? [] : null)}
        canWrite={canWrite}
        onOpen={(system) => open(ownerOfSummary(system), system.ref.systemId)}
        onNew={setMode}
        ownerTitle={(owner) =>
          owner.kind === "playground"
            ? "Playground"
            : ownerProjects.find((project) => project.id === owner.projectId)?.title
        }
        renderSwatches={(system) => (
          <LoadedSwatches
            environmentId={environmentId}
            owner={ownerOfSummary(system)}
            summary={system}
          />
        )}
      />
      {mode !== null ? (
        <NewDesignSystemDialog
          mode={mode}
          onModeChange={setMode}
          onOpenChange={(next) => !next && setMode(null)}
          projects={projects}
          defaultProjectId={projectId}
          figma={review.figma}
          onScan={review.onScan}
          {...(canCreate ? { onCreate } : {})}
          onPropose={async (input) => {
            const problem = await review.onPropose(input);
            if (problem === null) setMode(null);
            return problem;
          }}
        />
      ) : null}
      {review.dialog}
    </>
  );
}
