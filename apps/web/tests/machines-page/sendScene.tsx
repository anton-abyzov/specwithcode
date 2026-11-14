// `?scene=send&state=copy|move|none|main|several` (and `&folder=taken`): the Send to another
// machine… dialog as it opens on m5, a copy of a project whose Main is on m4, with the chosen
// machine holding a copy, Main, several copies or nothing. Buttons act locally; nothing is sent.
import { HandoffShare, type HandoffShareProps } from "../../src/components/studio/HandoffShare";
import { MachineHandoffDialog } from "../../src/components/studio/MachineHandoffDialog";

const state = new URLSearchParams(location.search).get("state") ?? "copy";
const project = {
  environmentId: "env-m5",
  id: "specweave-m5",
  title: "specweave",
  workspaceRoot: "/Users/anton/Projects/specweave",
  repositoryIdentity: {
    canonicalKey: "github.com/anton-abyzov/specweave",
    rootPath: "/Users/anton/Projects/specweave",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:anton-abyzov/specweave.git",
    },
    provider: "github",
    owner: "anton-abyzov",
    name: "specweave",
  },
} as never;
const copyAt = (environmentId: string, id: string, workspaceRoot: string) =>
  ({ environmentId, id, workspaceRoot }) as never;

const scenes: Record<
  string,
  { machine: string; label: string; holding: HandoffShareProps["holding"] }
> = {
  copy: {
    machine: "env-m1",
    label: "m1",
    holding: { kind: "copy", copy: copyAt("env-m1", "sw-m1", "/Users/anton/Projects/specweave") },
  },
  move: {
    machine: "env-m1",
    label: "m1",
    holding: { kind: "copy", copy: copyAt("env-m1", "sw-m1", "/Users/anton/Projects/specweave") },
  },
  main: {
    machine: "env-m4",
    label: "m4",
    holding: { kind: "main", copy: copyAt("env-m4", "sw-m4", "/Users/anton/Projects/specweave") },
  },
  several: {
    machine: "env-m1",
    label: "m1",
    holding: {
      kind: "several",
      mainId: null,
      copies: [
        copyAt("env-m1", "a", "/Users/anton/Projects/specweave"),
        copyAt("env-m1", "b", "/Users/anton/work/specweave"),
      ],
    },
  },
  none: { machine: "env-mini", label: "linux-mini", holding: { kind: "none" } },
};
const scene = scenes[state] ?? scenes.copy!;
const reasonOf = (machine: string) =>
  machine === scene.machine
    ? scene.holding.kind === "main"
      ? "Has Main"
      : scene.holding.kind === "copy"
        ? "Has a copy"
        : scene.holding.kind === "several"
          ? "Has 2 copies"
          : "No copy"
    : machine === "env-m4"
      ? "Has Main"
      : machine === "env-m1"
        ? "Has a copy"
        : "No copy";
const machines = [
  { value: "env-m4", label: "m4", tone: "ready" as const, reason: reasonOf("env-m4") },
  { value: "env-m1", label: "m1", tone: "ready" as const, reason: reasonOf("env-m1") },
  { value: "env-mini", label: "linux-mini", tone: "ready" as const, reason: reasonOf("env-mini") },
  { value: "env-m3", label: "m3", tone: "off" as const, reason: "Offline", disabled: true },
];

export function SendScene() {
  return (
    <div data-scene="send">
      <MachineHandoffDialog
        open
        onOpenChange={() => undefined}
        sourceLabel="m5"
        projectTitle="specweave"
        destinations={[]}
        selected=""
        onSelect={() => undefined}
        phase="choose"
        error={null}
        consent={false}
        onConsent={() => undefined}
        onReview={() => undefined}
        onContinue={() => undefined}
        onOpenDestination={() => undefined}
        shareFlow={
          <HandoffShare
            project={project}
            sourceLabel="m5"
            machines={machines}
            machine={scene.machine as never}
            machineLabel={scene.label}
            holding={scene.holding}
            mainLabel="m4"
            projectsRoot={state === "none" ? "/home/anton/Projects" : "/Users/anton/Projects"}
            joined={false}
            uncommittedFiles={3}
            loading={false}
            canClone
            onMachineChange={() => undefined}
            onMove={() => undefined}
            onSync={() => undefined}
            onCopyInstead={() => undefined}
            onPrepareRepositories={() => undefined}
            onNeedsFolderChoice={() => undefined}
            onBusyChange={() => undefined}
            onClose={() => undefined}
          />
        }
      />
    </div>
  );
}
