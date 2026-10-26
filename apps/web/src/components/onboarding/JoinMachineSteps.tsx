import { ArrowRightIcon, LaptopIcon, NetworkIcon } from "lucide-react";
import type { EnvironmentId } from "@specweave-studio/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  FleetInvitePanel,
  TailscaleReadinessNotice,
  useFleetInvite,
  useTailscaleReadiness,
} from "../settings/FleetInvite";
import { Button } from "../ui/button";

/**
 * First-run steps for a machine that only serves a main machine elsewhere:
 * the choice, the invitation line, and the status it opens to afterwards.
 * Choosing the main machine continues with the regular setup unchanged.
 */

export function MachineRoleStep({
  machineNoun,
  onJoin,
  onMain,
}: {
  /** "Mac" on macOS, otherwise "machine". */
  readonly machineNoun: string;
  readonly onJoin: () => void;
  readonly onMain: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        How will you use this {machineNoun}?
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        You can change this later.
      </p>
      <div className="mt-5 space-y-2">
        <Button
          variant="outline"
          size="sm-multiline"
          className="min-h-16 w-full justify-start text-left"
          onClick={onJoin}
        >
          <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Join my existing machines</span>
            <span className="block text-xs font-normal text-muted-foreground">
              This {machineNoun} only does work for a main machine elsewhere. For now, that needs
              Tailscale on both. Your app and phone can reach it through SpecWithCode Connect
              without Tailscale.
            </span>
          </span>
          <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
        <Button
          variant="outline"
          size="sm-multiline"
          className="min-h-16 w-full justify-start text-left"
          onClick={onMain}
        >
          <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              Set this {machineNoun} up as my main machine
            </span>
            <span className="block text-xs font-normal text-muted-foreground">
              Set up agents and projects here. You can add other machines to it later.
            </span>
          </span>
          <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </div>
    </>
  );
}

export function JoinMachineStep({
  environmentId,
  canManage,
  defaultName,
  machineNoun,
  onBack,
  onJoined,
  onDone,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly canManage: boolean;
  readonly defaultName: string | null;
  readonly machineNoun: string;
  readonly onBack: () => void;
  /** The line exists: this machine now serves a main machine elsewhere. */
  readonly onJoined: () => void;
  readonly onDone: () => void;
}) {
  const controller = useFleetInvite(environmentId);
  const allowed = canManage && environmentId !== null;
  const readiness = useTailscaleReadiness(environmentId, { enabled: allowed });
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: "invitation line" });
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Add this {machineNoun} to your main machine
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        For now, letting a main machine start work on this one also needs Tailscale on both. The app
        checks that Tailscale is installed and signed in here, then publishes this {machineNoun} on
        its private Tailscale name and makes one line for your main machine.
      </p>
      <div className="mt-5 space-y-3">
        {controller.invitation ? null : (
          <TailscaleReadinessNotice
            readiness={readiness}
            canManage={allowed}
            onCopyCommand={(command) => copyToClipboard(command, undefined)}
          />
        )}
        <FleetInvitePanel
          controller={{
            ...controller,
            create: async () => {
              const made = await controller.create();
              if (made) onJoined();
              return made;
            },
          }}
          defaultName={defaultName}
          canManage={allowed}
          blocked={readiness.blocksInvite}
          copied={isCopied}
          onCopy={(code) => copyToClipboard(code, undefined)}
          createLabel="Make the line"
        />
      </div>
      <div className="mt-6 flex justify-between gap-3">
        <Button
          variant="ghost"
          disabled={controller.pending !== null}
          onClick={() => {
            controller.reset();
            onBack();
          }}
        >
          Back
        </Button>
        {controller.invitation ? (
          <Button
            disabled={controller.pending !== null}
            onClick={() => {
              // The line is a credential: it is not shown again after this.
              controller.reset();
              onDone();
            }}
          >
            I pasted it
            <ArrowRightIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </>
  );
}

export function JoinedMachineStep({
  machineNoun,
  onNewLine,
  onFullSetup,
}: {
  readonly machineNoun: string;
  readonly onNewLine: () => void;
  readonly onFullSetup: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        This {machineNoun} is ready for your main machine
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        It is ready once you paste the line on your main machine under Settings &gt; Connections
        &gt; Add a machine. Choose Allow workers on its card there to let coordinators start work
        here, and keep the app running on this {machineNoun}.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onNewLine}>
          Make a new line
        </Button>
        <Button variant="ghost" onClick={onFullSetup}>
          Set this {machineNoun} up as a main machine instead
        </Button>
      </div>
    </>
  );
}
