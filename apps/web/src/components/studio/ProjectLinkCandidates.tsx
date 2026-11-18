import { ChevronRightIcon, LaptopIcon } from "lucide-react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { logicalProjectTitle, type EnvironmentId } from "@specweave-studio/contracts";
import { useTx } from "../../i18n";
import { useProjects } from "../../state/entities";
import {
  linkedMainEnvironmentId,
  type LinkCandidateGroups,
} from "../../studio/linkCandidateGroups";
import type { LinkCandidate } from "../../studio/projectLink";
import { useRetiredMachineRecords } from "../settings/useReplacedMachineRecords";
import { Radio, RadioGroup } from "../ui/radio-group";
import { useLinkMachines } from "./useLinkMachines";

const keyOf = (candidate: LinkCandidate) =>
  `${candidate.project.environmentId}:${candidate.project.id}`;

/**
 * The first step's subtitle. A project already linked with another machine names where the
 * coordinator is, by the role derivation the menus, Settings and the copy dialog share. One that is
 * not linked yet names none: its review decides which side keeps the coordinator.
 */
export function ProjectLinkChooseDescription({
  project,
}: {
  readonly project: EnvironmentProject;
}) {
  const tx = useTx();
  const projects = useProjects();
  const machines = useLinkMachines();
  const retired = useRetiredMachineRecords();
  const main = linkedMainEnvironmentId(project, projects, retired);
  const title = logicalProjectTitle(project);
  return main === null
    ? tx(
        "Pick {project} on another machine. Linking makes them one project with one coordinator.",
        { project: title },
      )
    : tx(
        "Pick {project} on another machine. The coordinator stays on {main}; you can continue it on another machine any time.",
        { project: title, main: machines.label(main as EnvironmentId) },
      );
}

/**
 * The link dialog's first step: the copies of this project on other machines, and every
 * other project folded under "Other projects" so a renamed or re-cloned copy can still be
 * linked on purpose. One radio group holds both lists. The fold opens by itself when no
 * copy was found, and a row picked inside it keeps it open.
 */
export function ProjectLinkCandidates({
  projectTitle,
  groups,
  selected,
  onSelect,
  othersOpen,
  onOthersOpen,
  scanned,
  machineLabel,
  machineProblem,
}: {
  readonly projectTitle: string;
  readonly groups: LinkCandidateGroups;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  /** The person's own choice for the fold; null until they use it. */
  readonly othersOpen: boolean | null;
  readonly onOthersOpen: (open: boolean) => void;
  /** Every folder that could be read has been; the rest are compared at the review. */
  readonly scanned: boolean;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly machineProblem: (environmentId: EnvironmentId) => string | null;
}) {
  const tx = useTx();
  const { copies, others } = groups;
  const noCopy = scanned && copies.length === 0;
  const pickedOther = others.some((candidate) => keyOf(candidate) === selected);
  const open = pickedOther || (othersOpen ?? noCopy);
  const row = (candidate: LinkCandidate) => {
    const problem = machineProblem(candidate.project.environmentId);
    const key = keyOf(candidate);
    return (
      <label
        key={key}
        data-slot="link-candidate"
        className={`grid min-w-0 grid-cols-[1.125rem_1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg border p-3 ${
          selected === key ? "border-primary bg-accent/40" : "border-border"
        } ${problem ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent/40"}`}
      >
        <span className="flex h-5 items-center justify-center">
          <Radio value={key} disabled={problem !== null} />
        </span>
        <span className="flex h-5 items-center justify-center">
          <LaptopIcon className="size-4 shrink-0" aria-hidden />
        </span>
        <span className="min-w-0 text-sm leading-5">
          <span className="block wrap-anywhere font-medium">
            {tx("{project} on {machine}", {
              project: logicalProjectTitle(candidate.project),
              machine: machineLabel(candidate.project.environmentId),
            })}
          </span>
          <span className="block break-all text-xs text-muted-foreground">
            {candidate.project.workspaceRoot}
          </span>
          <span className="mt-1 block wrap-anywhere text-xs">
            {problem ??
              (candidate.summary
                ? `${candidate.rootMatches === false ? tx("Not a copy:") + " " : ""}${candidate.summary}`
                : scanned
                  ? tx("Compared when you review the link.")
                  : tx("Reading folders…"))}
          </span>
        </span>
      </label>
    );
  };
  return (
    <RadioGroup
      value={selected}
      onValueChange={(value) => onSelect(String(value))}
      aria-label={tx("Other machine")}
    >
      {copies.map(row)}
      {copies.length === 0 && (
        <p
          className="text-sm text-muted-foreground"
          {...(noCopy ? { "data-link-no-copy": "" } : { role: "status" })}
        >
          {noCopy
            ? tx("{project} was not found on another machine.", { project: projectTitle })
            : tx("Reading folders…")}
        </p>
      )}
      {others.length > 0 && scanned && (
        <div data-slot="link-other-projects" className="min-w-0 space-y-2 pt-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onOthersOpen(!open)}
            className="flex cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden
            />
            {tx("Other projects ({count})", { count: String(others.length) })}
          </button>
          {open && (
            <>
              <p className="text-xs text-muted-foreground">
                {tx(
                  "Not copies of {project} as far as their folders show. Pick one only if it is a renamed or re-cloned copy.",
                  { project: projectTitle },
                )}
              </p>
              {others.map(row)}
            </>
          )}
        </div>
      )}
    </RadioGroup>
  );
}
