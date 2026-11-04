import { ArrowRightIcon, LaptopIcon, NetworkIcon } from "lucide-react";
import type { EnvironmentId } from "@specweave-studio/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  ConnectReadinessNotice,
  FleetInvitePanel,
  useFleetInvite,
  useTailscaleReadiness,
} from "../settings/FleetInvite";
import { Button } from "../ui/button";
import { useT } from "../../i18n";

/**
 * First-run steps for a machine that only serves a main machine elsewhere:
 * the choice, the invitation line, and the status it opens to afterwards.
 * Choosing the main machine continues with the regular setup unchanged.
 */

export function MachineRoleStep({
  machineNoun,
  onJoin,
  onMain,
  onLater,
}: {
  /** "Mac" on macOS, otherwise "machine". */
  readonly machineNoun: string;
  readonly onJoin: () => void;
  readonly onMain: () => void;
  /** Opens the app with nothing chosen or set up, e.g. to update first. */
  readonly onLater: () => void;
}) {
  const t = useT();
  const machine = machineNoun;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t("wizard.role.title", { machine })}
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        {t("wizard.role.changeLater")}
      </p>
      <div className="mt-5 space-y-2">
        <Button
          variant="outline"
          size="sm-multiline"
          className="min-h-16 w-full justify-start text-left"
          onClick={onMain}
        >
          <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("wizard.role.main.title")}</span>
            <span className="block text-xs font-normal text-muted-foreground">
              {t("wizard.role.main.description", { machine })}
            </span>
          </span>
          <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
        <Button
          variant="outline"
          size="sm-multiline"
          className="min-h-16 w-full justify-start text-left"
          onClick={onJoin}
        >
          <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("wizard.role.join.title")}</span>
            <span className="block text-xs font-normal text-muted-foreground">
              {t("wizard.role.join.description", { machine })}
            </span>
          </span>
          <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </div>
      <div className="mt-4 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
        <Button variant="ghost" size="sm" onClick={onLater}>
          {t("wizard.role.later")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("wizard.role.laterHint")}</p>
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
  const t = useT();
  const machine = machineNoun;
  const allowed = canManage && environmentId !== null;
  const readiness = useTailscaleReadiness(environmentId, { enabled: allowed });
  const controller = useFleetInvite(environmentId, readiness.status?.connect !== undefined);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: "invitation line" });
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t("wizard.join.title", { machine })}
      </h1>
      <ol className="mt-2.5 list-decimal space-y-1 ps-5 text-sm leading-relaxed text-muted-foreground">
        <li>{t("wizard.join.step1", { machine })}</li>
        <li>{t("wizard.join.step2")}</li>
        <li>{t("wizard.join.step3")}</li>
      </ol>
      <div className="mt-5 space-y-3">
        {controller.invitation ? null : (
          <ConnectReadinessNotice
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
          createLabel={t("wizard.join.makeLine")}
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
          {t("wizard.back")}
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
            {t("wizard.join.pasted")}
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
  const t = useT();
  const machine = machineNoun;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t("wizard.joined.title", { machine })}
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        {t("wizard.joined.description", { machine })}
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onNewLine}>
          {t("wizard.joined.newLine")}
        </Button>
        <Button variant="ghost" onClick={onFullSetup}>
          {t("wizard.joined.fullSetup", { machine })}
        </Button>
      </div>
    </>
  );
}
